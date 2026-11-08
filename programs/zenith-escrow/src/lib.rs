//! Zenith Escrow — a job escrow whose payout is decided by the Zenith oracle.
//!
//! 1. Client locks tokens (e.g. USDC) for a job with a short written spec.
//! 2. Freelancer delivers: they open a Zenith oracle request whose prompt is
//!    "SPEC: <spec>\nDELIVERABLE: <work>" bound to this job, and attach it.
//! 3. The oracle's optimistic AI game decides YES (meets spec) or NO.
//! 4. Anyone cranks `settle`: YES pays the freelancer, NO refunds the client.
//!
//! The escrow reads oracle `Request` accounts directly (owner + discriminator
//! check, then Borsh decode) — no crate dependency — which is how any Solana
//! program can compose with Zenith.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("ERkb4H2QoMxBwqKuxStXEsJXUF2idiDRnpkRPWapV46Y");

/// Program ID of the deployed Zenith oracle. Update after `anchor keys sync`
/// (`npm run sync-ids` does this for you).
pub const ORACLE_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("BwhUSJMFrZbK6Ac4vydsEDYSSz3FZSAdLehBoF7C42mj");

/// sha256("account:Request")[..8] — Anchor discriminator of the oracle Request.
pub const REQUEST_DISCRIMINATOR: [u8; 8] = [125, 172, 150, 161, 162, 115, 39, 71];

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_FINALIZED: u8 = 3;
pub const STATUS_CANCELLED: u8 = 4;
pub const VERDICT_YES: u8 = 1;
pub const VERDICT_NO: u8 = 2;

/// Mirror of `zenith_oracle::Request` (same field order and types).
#[derive(AnchorDeserialize, AnchorSerialize, Clone, Debug)]
pub struct OracleRequest {
    pub requester: Pubkey,
    pub request_id: u64,
    pub subject: Pubkey,
    pub reward: u64,
    pub bond: u64,
    pub window_secs: i64,
    pub jury_timeout_secs: i64,
    pub created_at: i64,
    pub status: u8,
    pub proposer: Pubkey,
    pub proposed_verdict: u8,
    pub proposed_at: i64,
    pub challenger: Pubkey,
    pub challenged_verdict: u8,
    pub challenged_at: i64,
    pub votes: [u8; 3],
    pub final_verdict: u8,
    pub winner: Pubkey,
    pub finalized_at: i64,
    pub bump: u8,
    pub prompt: String,
    pub proposer_reasoning: String,
    pub challenger_reasoning: String,
}

impl OracleRequest {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*info.owner, ORACLE_PROGRAM_ID, EscrowError::NotOracleAccount);
        let data = info.try_borrow_data()?;
        require!(
            data.len() > 8 && data[..8] == REQUEST_DISCRIMINATOR,
            EscrowError::NotOracleAccount
        );
        let mut body: &[u8] = &data[8..];
        OracleRequest::deserialize(&mut body).map_err(|_| error!(EscrowError::NotOracleAccount))
    }
}

pub const MAX_SPEC_LEN: usize = 200;
pub const JOB_SEED: &[u8] = b"job";
pub const VAULT_SEED: &[u8] = b"vault";

pub const JOB_FUNDED: u8 = 0;
pub const JOB_SUBMITTED: u8 = 1;
pub const JOB_PAID: u8 = 2;
pub const JOB_REFUNDED: u8 = 3;

pub fn expected_prompt_prefix(spec: &str) -> String {
    format!("SPEC: {}\nDELIVERABLE: ", spec)
}

#[program]
pub mod zenith_escrow {
    use super::*;

    pub fn create_job(
        ctx: Context<CreateJob>,
        job_id: u64,
        amount: u64,
        freelancer: Pubkey,
        spec: String,
        deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(!spec.is_empty(), EscrowError::EmptySpec);
        require!(spec.len() <= MAX_SPEC_LEN, EscrowError::SpecTooLong);
        require!(
            deadline > Clock::get()?.unix_timestamp,
            EscrowError::DeadlineInPast
        );

        let job = &mut ctx.accounts.job;
        job.client = ctx.accounts.client.key();
        job.freelancer = freelancer;
        job.mint = ctx.accounts.mint.key();
        job.job_id = job_id;
        job.amount = amount;
        job.deadline = deadline;
        job.status = JOB_FUNDED;
        job.request = Pubkey::default();
        job.bump = ctx.bumps.job;
        job.vault_bump = ctx.bumps.vault;
        job.spec = spec;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.client_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(JobCreated {
            job: ctx.accounts.job.key(),
            client: ctx.accounts.job.client,
            freelancer,
            amount,
        });
        Ok(())
    }

    /// Freelancer attaches a fresh oracle request that judges their work.
    /// The prompt must start with the job's own spec, so the freelancer cannot
    /// rewrite what is being judged.
    pub fn submit_work(ctx: Context<SubmitWork>) -> Result<()> {
        let request_key = ctx.accounts.request.key();
        let request = OracleRequest::load(&ctx.accounts.request.to_account_info())?;
        let job = &mut ctx.accounts.job;
        require!(job.status == JOB_FUNDED, EscrowError::WrongJobStatus);
        require_keys_eq!(request.subject, job.key(), EscrowError::RequestNotForJob);
        require_keys_eq!(
            request.requester,
            ctx.accounts.freelancer.key(),
            EscrowError::RequestNotFromFreelancer
        );
        require!(request.status == STATUS_OPEN, EscrowError::RequestNotFresh);
        let prefix = expected_prompt_prefix(&job.spec);
        require!(
            request.prompt.starts_with(&prefix) && request.prompt.len() > prefix.len(),
            EscrowError::PromptDoesNotMatchSpec
        );

        job.request = request_key;
        job.status = JOB_SUBMITTED;
        emit!(WorkSubmitted {
            job: job.key(),
            request: request_key,
        });
        Ok(())
    }

    /// Permissionless crank once the oracle has finalized.
    /// YES -> pay freelancer. NO -> refund client.
    /// If the oracle request was cancelled (jury timeout), the job reopens.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        require!(
            ctx.accounts.job.status == JOB_SUBMITTED,
            EscrowError::WrongJobStatus
        );
        require_keys_eq!(
            ctx.accounts.request.key(),
            ctx.accounts.job.request,
            EscrowError::RequestNotForJob
        );
        let request = OracleRequest::load(&ctx.accounts.request.to_account_info())?;

        if request.status == STATUS_CANCELLED {
            let job = &mut ctx.accounts.job;
            job.status = JOB_FUNDED;
            job.request = Pubkey::default();
            return Ok(());
        }
        require!(
            request.status == STATUS_FINALIZED,
            EscrowError::OracleNotFinal
        );

        let (destination, new_status) = match request.final_verdict {
            VERDICT_YES => (ctx.accounts.freelancer_token.to_account_info(), JOB_PAID),
            VERDICT_NO => (ctx.accounts.client_token.to_account_info(), JOB_REFUNDED),
            _ => return err!(EscrowError::OracleNotFinal),
        };

        let verdict = request.final_verdict;
        pay_out_of_vault(
            &ctx.accounts.job,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            destination,
            &ctx.accounts.token_program,
        )?;

        let job = &mut ctx.accounts.job;
        job.status = new_status;
        emit!(JobSettled {
            job: job.key(),
            verdict,
            amount: job.amount,
        });
        Ok(())
    }

    /// Client reclaims funds if no work was attached before the deadline.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        require!(
            ctx.accounts.job.status == JOB_FUNDED,
            EscrowError::WrongJobStatus
        );
        require!(
            Clock::get()?.unix_timestamp > ctx.accounts.job.deadline,
            EscrowError::DeadlineNotReached
        );
        pay_out_of_vault(
            &ctx.accounts.job,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.client_token.to_account_info(),
            &ctx.accounts.token_program,
        )?;
        ctx.accounts.job.status = JOB_REFUNDED;
        Ok(())
    }
}

fn pay_out_of_vault<'info>(
    job: &Account<'info, Job>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let job_id_bytes = job.job_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        JOB_SEED,
        job.client.as_ref(),
        job_id_bytes.as_ref(),
        &[job.bump],
    ];
    let signer = &[seeds];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination,
                authority: job.to_account_info(),
            },
            signer,
        ),
        job.amount,
        mint.decimals,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Job {
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub mint: Pubkey,
    pub job_id: u64,
    pub amount: u64,
    pub deadline: i64,
    pub status: u8,
    /// The Zenith oracle request judging this job (default until submitted).
    pub request: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    #[max_len(MAX_SPEC_LEN)]
    pub spec: String,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct CreateJob<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = client,
        token::token_program = token_program
    )]
    pub client_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = client,
        space = 8 + Job::INIT_SPACE,
        seeds = [JOB_SEED, client.key().as_ref(), &job_id.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(
        init,
        payer = client,
        seeds = [VAULT_SEED, job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    pub freelancer: Signer<'info>,
    #[account(mut, has_one = freelancer)]
    pub job: Account<'info, Job>,
    /// CHECK: verified in `OracleRequest::load` (owner = oracle program + discriminator).
    pub request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, has_one = mint)]
    pub job: Account<'info, Job>,
    /// CHECK: verified in `OracleRequest::load` and pinned to `job.request`.
    pub request: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, job.key().as_ref()],
        bump = job.vault_bump,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = job.client,
        token::token_program = token_program
    )]
    pub client_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = job.freelancer,
        token::token_program = token_program
    )]
    pub freelancer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    pub client: Signer<'info>,
    #[account(mut, has_one = client, has_one = mint)]
    pub job: Account<'info, Job>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, job.key().as_ref()],
        bump = job.vault_bump,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = client,
        token::token_program = token_program
    )]
    pub client_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct JobCreated {
    pub job: Pubkey,
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WorkSubmitted {
    pub job: Pubkey,
    pub request: Pubkey,
}

#[event]
pub struct JobSettled {
    pub job: Pubkey,
    pub verdict: u8,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Account is not a Zenith oracle request")]
    NotOracleAccount,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Spec must not be empty")]
    EmptySpec,
    #[msg("Spec is too long")]
    SpecTooLong,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Job is not in the right status for this action")]
    WrongJobStatus,
    #[msg("Oracle request is not bound to this job")]
    RequestNotForJob,
    #[msg("Oracle request must be opened by the freelancer")]
    RequestNotFromFreelancer,
    #[msg("Oracle request must be fresh (no answer yet)")]
    RequestNotFresh,
    #[msg("Oracle prompt must start with this job's spec")]
    PromptDoesNotMatchSpec,
    #[msg("Oracle has not finalized a verdict yet")]
    OracleNotFinal,
    #[msg("Deadline has not passed yet")]
    DeadlineNotReached,
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The escrow's mirror of the oracle Request must decode real oracle data.
    #[test]
    fn mirror_matches_oracle_layout() {
        use anchor_lang::{AccountSerialize, Discriminator};
        assert_eq!(zenith_oracle::Request::DISCRIMINATOR, REQUEST_DISCRIMINATOR);
        assert_eq!(zenith_oracle::ID, ORACLE_PROGRAM_ID);
        let r = zenith_oracle::Request {
            requester: Pubkey::new_unique(),
            request_id: 7,
            subject: Pubkey::new_unique(),
            reward: 1,
            bond: 2,
            window_secs: 3,
            jury_timeout_secs: 4,
            created_at: 5,
            status: zenith_oracle::STATUS_FINALIZED,
            proposer: Pubkey::new_unique(),
            proposed_verdict: 1,
            proposed_at: 6,
            challenger: Pubkey::new_unique(),
            challenged_verdict: 2,
            challenged_at: 8,
            votes: [2, 2, 0],
            final_verdict: zenith_oracle::VERDICT_NO,
            winner: Pubkey::new_unique(),
            finalized_at: 9,
            bump: 254,
            prompt: "SPEC: x\nDELIVERABLE: y".into(),
            proposer_reasoning: "a".into(),
            challenger_reasoning: "b".into(),
        };
        let mut data = Vec::new();
        r.try_serialize(&mut data).unwrap();
        data.resize(8 + zenith_oracle::Request::INIT_SPACE, 0); // real accounts are padded
        let mut lamports = 0u64;
        let key = Pubkey::new_unique();
        let info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut data, &ORACLE_PROGRAM_ID, false, 0,
        );
        let m = OracleRequest::load(&info).unwrap();
        assert_eq!(m.subject, r.subject);
        assert_eq!(m.status, STATUS_FINALIZED);
        assert_eq!(m.final_verdict, VERDICT_NO);
        assert_eq!(m.votes, [2, 2, 0]);
        assert_eq!(m.prompt, r.prompt);
        assert_eq!(m.challenger_reasoning, "b");

        let wrong_owner = Pubkey::new_unique();
        let info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut data, &wrong_owner, false, 0,
        );
        assert!(OracleRequest::load(&info).is_err());
    }
}
