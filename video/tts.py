# Generates one WAV per narration line with Kokoro (open source, Apache-2.0).
# Usage: python video/tts.py [voice]   -> video/voice/<scene>_<i>.wav
import json, os, sys
import numpy as np
import soundfile as sf
from kokoro import KPipeline

voice = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "voice")
os.makedirs(out, exist_ok=True)
pipe = KPipeline(lang_code="a")  # American English
scenes = json.load(open(os.path.join(here, "narration.json")))
for scene, lines in scenes:
    for i, (_, text) in enumerate(lines):
        chunks = [audio for _, _, audio in pipe(text, voice=voice, speed=1.0, split_pattern=None)]
        audio = np.concatenate([np.asarray(c) for c in chunks])
        sf.write(os.path.join(out, f"{scene}_{i}.wav"), audio, 24000)
        print(f"{scene}_{i}: {len(audio) / 24000:.2f}s  {text[:50]}")
print("TTS_DONE")
