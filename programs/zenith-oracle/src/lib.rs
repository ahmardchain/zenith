//! Zenith — an optimistic AI oracle for Solana.
//!
//! Anyone can ask a yes/no question that needs judgment (for example
//! "does this deliverable meet the spec?"). An AI solver answers by posting
//! a verdict together with a SOL bond. During a short challenge window anyone
//! who disagrees can post an equal bond with the opposite verdict. If nobody
//! challenges, the answer finalizes and the solver earns the reward. If it is
//! challenged, a jury of independent AI models (each run by its own juror key)
//! votes; the majority side takes the reward plus the loser's slashed bond.
//!
//! Consumer programs read a FINALIZED `Request` account directly
//! (see `zenith-escrow`), so any Solana program can compose with it.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("BwhUSJMFrZbK6Ac4vydsEDYSSz3FZSAdLehBoF7C42mj");

pub const MAX_PROMPT_LEN: usize = 600;
pub const MAX_REASONING_LEN: usize = 200;
pub const NUM_JURORS: usize = 3;
pub const JURY_MAJORITY: u8 = 2;

pub const VERDICT_NONE: u8 = 0;
pub const VERDICT_YES: u8 = 1;
pub const VERDICT_NO: u8 = 2;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PROPOSED: u8 = 1;
pub const STATUS_CHALLENGED: u8 = 2;
pub const STATUS_FINALIZED: u8 = 3;
pub const STATUS_CANCELLED: u8 = 4;

pub const CONFIG_SEED: &[u8] = b"config";
pub const REQUEST_SEED: &[u8] = b"request";

#[program]
pub mod zenith_oracle {
    use super::*;

    /// One-time setup of the oracle parameters and the juror set.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.config;
        config.apply(&params);
        Ok(())
    }

    /// Admin can tune bond size, windows and rotate jurors (demo convenience).
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        ctx.accounts.config.apply(&params);
        Ok(())
    }

    /// Ask a yes/no question. The reward (lamports) is escrowed in the request PDA.
    /// `subject` is an arbitrary key a consumer program binds the answer to
    /// (for example an escrow job PDA).
    pub fn create_request(
        ctx: Context<CreateRequest>,
        request_id: u64,
        subject: Pubkey,
        prompt: String,
        reward: u64,
    ) -> Result<()> {
        require!(!prompt.is_empty(), OracleError::EmptyPrompt);
        require!(prompt.len() <= MAX_PROMPT_LEN, OracleError::PromptTooLong);

        let config = &ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        let request = &mut ctx.accounts.request;
        request.requester = ctx.accounts.requester.key();
        request.request_id = request_id;
        request.subject = subject;
        request.reward = reward;
        request.bond = config.bond;
        request.window_secs = config.window_secs;
        request.jury_timeout_secs = config.jury_timeout_secs;
        request.created_at = now;
        request.status = STATUS_OPEN;
        request.bump = ctx.bumps.request;
        request.prompt = prompt;

        if reward > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.requester.to_account_info(),
                        to: ctx.accounts.request.to_account_info(),
                    },
                ),
                reward,
            )?;
        }

        emit!(RequestCreated {
            request: ctx.accounts.request.key(),
            requester: ctx.accounts.requester.key(),
            subject,
            reward,
        });
        Ok(())
    }

    /// An AI solver answers, putting up a bond that can be slashed.
    pub fn propose(ctx: Context<Propose>, verdict: u8, reasoning: String) -> Result<()> {
        require!(is_valid_verdict(verdict), OracleError::InvalidVerdict);
        require!(reasoning.len() <= MAX_REASONING_LEN, OracleError::ReasoningTooLong);
        require!(
            ctx.accounts.request.status == STATUS_OPEN,
            OracleError::WrongStatus
        );

        let bond = ctx.accounts.request.bond;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.proposer.to_account_info(),
                    to: ctx.accounts.request.to_account_info(),
                },
            ),
            bond,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let request = &mut ctx.accounts.request;
        request.proposer = ctx.accounts.proposer.key();
        request.proposed_verdict = verdict;
        request.proposer_reasoning = reasoning;
        request.proposed_at = now;
        request.status = STATUS_PROPOSED;

        emit!(Proposed {
            request: request.key(),
            proposer: request.proposer,
            verdict,
            challenge_deadline: now + request.window_secs,
        });
        Ok(())
    }

    /// Anyone who disagrees can dispute within the window by matching the bond.
    pub fn challenge(ctx: Context<Challenge>, verdict: u8, reasoning: String) -> Result<()> {
        require!(is_valid_verdict(verdict), OracleError::InvalidVerdict);
        require!(reasoning.len() <= MAX_REASONING_LEN, OracleError::ReasoningTooLong);
        let now = Clock::get()?.unix_timestamp;
        {
            let request = &ctx.accounts.request;
            require!(request.status == STATUS_PROPOSED, OracleError::WrongStatus);
            require!(
                now < request.proposed_at + request.window_secs,
                OracleError::ChallengeWindowClosed
            );
            require!(
                verdict != request.proposed_verdict,
                OracleError::ChallengeMustDisagree
            );
            require_keys_neq!(
                ctx.accounts.challenger.key(),
                request.proposer,
                OracleError::SelfChallenge
            );
        }

        let bond = ctx.accounts.request.bond;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.challenger.to_account_info(),
                    to: ctx.accounts.request.to_account_info(),
                },
            ),
            bond,
        )?;

        let request = &mut ctx.accounts.request;
        request.challenger = ctx.accounts.challenger.key();
        request.challenged_verdict = verdict;
        request.challenger_reasoning = reasoning;
        request.challenged_at = now;
        request.status = STATUS_CHALLENGED;

        emit!(Challenged {
            request: request.key(),
            challenger: request.challenger,
            verdict,
        });
        Ok(())
    }

    /// A juror (one independent model) votes on a disputed request.
    /// The vote that reaches a majority settles the dispute and pays the winner:
    /// reward + its own bond + the loser's slashed bond.
    pub fn vote(ctx: Context<Vote>, verdict: u8) -> Result<()> {
        require!(is_valid_verdict(verdict), OracleError::InvalidVerdict);
        let juror_key = ctx.accounts.juror.key();
        let juror_index = ctx
            .accounts
            .config
            .jurors
            .iter()
            .position(|j| *j == juror_key)
            .ok_or(OracleError::NotAJuror)?;

        let request = &mut ctx.accounts.request;
        require!(request.status == STATUS_CHALLENGED, OracleError::WrongStatus);
        require!(
            request.votes[juror_index] == VERDICT_NONE,
            OracleError::AlreadyVoted
        );
        request.votes[juror_index] = verdict;

        let tally = request.votes.iter().filter(|v| **v == verdict).count() as u8;
        emit!(Voted {
            request: request.key(),
            juror: juror_key,
            verdict,
        });

        if tally < JURY_MAJORITY {
            return Ok(());
        }

        let (winner_info, loser) = if verdict == request.proposed_verdict {
            (ctx.accounts.proposer.to_account_info(), request.challenger)
        } else {
            (ctx.accounts.challenger.to_account_info(), request.proposer)
        };
        let payout = request
            .reward
            .checked_add(request.bond.checked_mul(2).ok_or(OracleError::MathOverflow)?)
            .ok_or(OracleError::MathOverflow)?;

        request.final_verdict = verdict;
        request.winner = winner_info.key();
        request.finalized_at = Clock::get()?.unix_timestamp;
        request.status = STATUS_FINALIZED;

        move_lamports(&request.to_account_info(), &winner_info, payout)?;

        emit!(Finalized {
            request: request.key(),
            verdict,
            winner: winner_info.key(),
            slashed: loser,
            disputed: true,
        });
        Ok(())
    }

    /// Unchallenged answer: after the window passes anyone can finalize it.
    /// The proposer gets the reward and their bond back.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let request = &mut ctx.accounts.request;
        require!(request.status == STATUS_PROPOSED, OracleError::WrongStatus);
        require!(
            now >= request.proposed_at + request.window_secs,
            OracleError::ChallengeWindowOpen
        );

        let payout = request
            .reward
            .checked_add(request.bond)
            .ok_or(OracleError::MathOverflow)?;
        request.final_verdict = request.proposed_verdict;
        request.winner = request.proposer;
        request.finalized_at = now;
        request.status = STATUS_FINALIZED;

        move_lamports(
            &request.to_account_info(),
            &ctx.accounts.proposer.to_account_info(),
            payout,
        )?;

        emit!(Finalized {
            request: request.key(),
            verdict: request.final_verdict,
            winner: request.proposer,
            slashed: Pubkey::default(),
            disputed: false,
        });
        Ok(())
    }

    /// Safety valve: if a dispute is not resolved before the jury timeout,
    /// both bonds are returned and the reward goes back to the requester.
    pub fn expire_dispute(ctx: Context<ExpireDispute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let request = &mut ctx.accounts.request;
        require!(request.status == STATUS_CHALLENGED, OracleError::WrongStatus);
        require!(
            now >= request.challenged_at + request.jury_timeout_secs,
            OracleError::JuryStillOpen
        );
        let (bond, reward) = (request.bond, request.reward);
        request.status = STATUS_CANCELLED;
        request.finalized_at = now;

        let from = request.to_account_info();
        move_lamports(&from, &ctx.accounts.proposer.to_account_info(), bond)?;
        move_lamports(&from, &ctx.accounts.challenger.to_account_info(), bond)?;
        move_lamports(&from, &ctx.accounts.requester.to_account_info(), reward)?;
        Ok(())
    }

    /// Requester withdraws an unanswered request and gets the reward back.
    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        let request = &mut ctx.accounts.request;
        require!(request.status == STATUS_OPEN, OracleError::WrongStatus);
        let reward = request.reward;
        request.status = STATUS_CANCELLED;
        request.finalized_at = Clock::get()?.unix_timestamp;
        move_lamports(
            &request.to_account_info(),
            &ctx.accounts.requester.to_account_info(),
            reward,
        )?;
        Ok(())
    }
}

fn is_valid_verdict(v: u8) -> bool {
    v == VERDICT_YES || v == VERDICT_NO
}

/// Move lamports out of a program-owned account. Only escrowed reward/bond
/// lamports are ever moved, so the account stays rent-exempt.
fn move_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(OracleError::MathOverflow)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(OracleError::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    /// Bond in lamports each side must post.
    pub bond: u64,
    /// Seconds an answer stays open to challenge.
    pub window_secs: i64,
    /// Seconds the jury has before a dispute can be expired.
    pub jury_timeout_secs: i64,
    pub jurors: [Pubkey; NUM_JURORS],
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(self.bond > 0, OracleError::InvalidConfig);
        require!(self.window_secs > 0, OracleError::InvalidConfig);
        require!(self.jury_timeout_secs > 0, OracleError::InvalidConfig);
        for (i, a) in self.jurors.iter().enumerate() {
            require_keys_neq!(*a, Pubkey::default(), OracleError::InvalidConfig);
            for b in self.jurors.iter().skip(i + 1) {
                require_keys_neq!(*a, *b, OracleError::InvalidConfig);
            }
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub bond: u64,
    pub window_secs: i64,
    pub jury_timeout_secs: i64,
    pub jurors: [Pubkey; NUM_JURORS],
    pub bump: u8,
}

impl Config {
    fn apply(&mut self, p: &ConfigParams) {
        self.bond = p.bond;
        self.window_secs = p.window_secs;
        self.jury_timeout_secs = p.jury_timeout_secs;
        self.jurors = p.jurors;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Request {
    pub requester: Pubkey,
    pub request_id: u64,
    /// Key a consumer program binds this answer to (e.g. an escrow job PDA).
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

    /// One slot per juror in `Config::jurors` order.
    pub votes: [u8; NUM_JURORS],

    pub final_verdict: u8,
    pub winner: Pubkey,
    pub finalized_at: i64,
    pub bump: u8,

    #[max_len(MAX_PROMPT_LEN)]
    pub prompt: String,
    #[max_len(MAX_REASONING_LEN)]
    pub proposer_reasoning: String,
    #[max_len(MAX_REASONING_LEN)]
    pub challenger_reasoning: String,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct CreateRequest<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = requester,
        space = 8 + Request::INIT_SPACE,
        seeds = [REQUEST_SEED, requester.key().as_ref(), &request_id.to_le_bytes()],
        bump
    )]
    pub request: Account<'info, Request>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Propose<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut)]
    pub request: Account<'info, Request>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Challenge<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(mut)]
    pub request: Account<'info, Request>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    pub juror: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub request: Account<'info, Request>,
    /// CHECK: only receives lamports; address pinned to the request's proposer.
    #[account(mut, address = request.proposer)]
    pub proposer: UncheckedAccount<'info>,
    /// CHECK: only receives lamports; address pinned to the request's challenger.
    #[account(mut, address = request.challenger)]
    pub challenger: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)]
    pub request: Account<'info, Request>,
    /// CHECK: only receives lamports; address pinned to the request's proposer.
    #[account(mut, address = request.proposer)]
    pub proposer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ExpireDispute<'info> {
    #[account(mut)]
    pub request: Account<'info, Request>,
    /// CHECK: only receives lamports.
    #[account(mut, address = request.proposer)]
    pub proposer: UncheckedAccount<'info>,
    /// CHECK: only receives lamports.
    #[account(mut, address = request.challenger)]
    pub challenger: UncheckedAccount<'info>,
    /// CHECK: only receives lamports.
    #[account(mut, address = request.requester)]
    pub requester: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelRequest<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut, has_one = requester)]
    pub request: Account<'info, Request>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct RequestCreated {
    pub request: Pubkey,
    pub requester: Pubkey,
    pub subject: Pubkey,
    pub reward: u64,
}

#[event]
pub struct Proposed {
    pub request: Pubkey,
    pub proposer: Pubkey,
    pub verdict: u8,
    pub challenge_deadline: i64,
}

#[event]
pub struct Challenged {
    pub request: Pubkey,
    pub challenger: Pubkey,
    pub verdict: u8,
}

#[event]
pub struct Voted {
    pub request: Pubkey,
    pub juror: Pubkey,
    pub verdict: u8,
}

#[event]
pub struct Finalized {
    pub request: Pubkey,
    pub verdict: u8,
    pub winner: Pubkey,
    pub slashed: Pubkey,
    pub disputed: bool,
}

#[error_code]
pub enum OracleError {
    #[msg("Prompt must not be empty")]
    EmptyPrompt,
    #[msg("Prompt is too long")]
    PromptTooLong,
    #[msg("Reasoning is too long")]
    ReasoningTooLong,
    #[msg("Verdict must be 1 (YES) or 2 (NO)")]
    InvalidVerdict,
    #[msg("Request is not in the right status for this action")]
    WrongStatus,
    #[msg("Challenge window has closed")]
    ChallengeWindowClosed,
    #[msg("Challenge window is still open")]
    ChallengeWindowOpen,
    #[msg("A challenge must propose the opposite verdict")]
    ChallengeMustDisagree,
    #[msg("Proposer cannot challenge their own answer")]
    SelfChallenge,
    #[msg("Signer is not a registered juror")]
    NotAJuror,
    #[msg("Juror already voted on this request")]
    AlreadyVoted,
    #[msg("Jury timeout has not passed yet")]
    JuryStillOpen,
    #[msg("Invalid config")]
    InvalidConfig,
    #[msg("Math overflow")]
    MathOverflow,
}
