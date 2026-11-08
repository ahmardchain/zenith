"""Assemble the Zenith demo video from scenes.html frames + per-line voice WAVs.

Timeline: each narration line starts its listed visual steps; if a line lists
several steps they are spread evenly across that line. Lines are separated by a
short pause, scenes by a slightly longer one.
"""
import json, os, subprocess, wave

ROOT = os.path.dirname(os.path.abspath(__file__))
VOICE = os.path.join(ROOT, "voice")
FRAMES = os.path.join(ROOT, "frames")
NARR = json.load(open(os.path.join(ROOT, "narration.json")))
LEAD, GAP, SCENE_TAIL, END_TAIL = 0.5, 0.35, 0.45, 2.5
os.makedirs(FRAMES, exist_ok=True)


def wav_len(p):
    with wave.open(p) as w:
        return w.getnframes() / w.getframerate()


def render(scene, step):
    out = os.path.join(FRAMES, f"{scene}-{step}.png")
    if not os.path.exists(out):
        subprocess.run([
            "google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
            "--window-size=1920,1080", "--virtual-time-budget=3000", f"--screenshot={out}",
            f"file://{ROOT}/scenes.html#{scene}-{step}",
        ], check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    return out


segments = []   # (image, seconds)
audio = []      # ("wav", path) | ("sil", seconds)
total = 0.0
for si, (scene, lines) in enumerate(NARR):
    events = []  # (time_in_scene, step)
    t = LEAD
    audio.append(("sil", LEAD))
    for li, (steps, _text) in enumerate(lines):
        p = os.path.join(VOICE, f"{scene}_{li}.wav")
        d = wav_len(p)
        for k, st in enumerate(steps):
            events.append((t + d * k / len(steps), st))
        audio.append(("wav", p))
        t += d
        gap = GAP if li < len(lines) - 1 else (END_TAIL if scene == "end" else SCENE_TAIL)
        audio.append(("sil", gap))
        t += gap
    scene_len = t
    events[0] = (0.0, events[0][1])
    for i, (et, st) in enumerate(events):
        nxt = events[i + 1][0] if i + 1 < len(events) else scene_len
        segments.append((render(scene, st), nxt - et))
    total += scene_len
    print(f"{scene:7s} {scene_len:6.2f}s  steps {[s for _, s in events]}")

print(f"TOTAL {total:.1f}s")

# --- video: concat demuxer of stills
with open(os.path.join(ROOT, "video.txt"), "w") as f:
    for img, d in segments:
        f.write(f"file '{img}'\nduration {d:.3f}\n")
    f.write(f"file '{segments[-1][0]}'\n")

# --- audio: concat wavs and silences (24 kHz mono)
parts, filt = [], []
for i, (kind, v) in enumerate(audio):
    if kind == "wav":
        parts += ["-i", v]
    else:
        parts += ["-f", "lavfi", "-t", f"{v:.3f}", "-i", "anullsrc=r=24000:cl=mono"]
    filt.append(f"[{i}:a]")
filter_complex = "".join(filt) + f"concat=n={len(audio)}:v=0:a=1[a]"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *parts, "-filter_complex", filter_complex,
                "-map", "[a]", "-ar", "48000", os.path.join(ROOT, "voice.wav")], check=True)

out = os.path.join(ROOT, "zenith-demo.mp4")
subprocess.run([
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", os.path.join(ROOT, "video.txt"),
    "-i", os.path.join(ROOT, "voice.wav"),
    "-vf", f"fps=30,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.6:.2f}:d=0.6",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-ar", "48000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", "-shortest", out,
], check=True)
print("WROTE", out)
