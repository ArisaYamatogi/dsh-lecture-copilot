"""Build a Chinese-accented English lecture corpus for recognizer evaluation.

Uses Microsoft Edge's read-aloud service through `edge-tts`, which carries the
Hong Kong and Singapore English voices — the closest available stand-ins for the
Chinese-accented English a mainland lecturer speaks. A Mandarin voice reading
English is included as the heavy-accent case.

The service emits 24 kHz MP3; the recognizer accepts only 16 kHz mono PCM16 WAV,
so every clip is resampled with PyAV.

Requires: edge-tts, av
Usage:    python synth-corpus.py <outDir>
"""

import io
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import av

# The same sentences for every voice, so the transcripts compare directly.
TEXT = (
    "Consider the function f of x equals x squared. "
    "Its derivative is two x by the power rule. "
    "Now suppose we want the limit of sine x over x as x tends to zero. "
    "By the squeeze theorem that limit is equal to one. "
    "The time complexity of binary search is log n."
)

VOICES = [
    # (label, edge voice, accent note)
    ("hk-male", "en-HK-SamNeural", "Hong Kong English, male"),
    ("hk-female", "en-HK-YanNeural", "Hong Kong English, female"),
    ("sg-male", "en-SG-WayneNeural", "Singapore English, male"),
    ("zh-male-reading-en", "zh-CN-YunxiNeural", "Mandarin voice reading English, male"),
    ("us-baseline", "en-US-AndrewMultilingualNeural", "US English, male (control)"),
]

TARGET_RATE = 16000


def speak(voice: str, text: str, work: Path) -> Path:
    """Synthesize one utterance to an MP3 file and return its path."""
    media = work / "line.mp3"
    if media.exists():
        media.unlink()
    subprocess.run(
        [sys.executable, "-m", "edge_tts", "--voice", voice, "--text", text,
         "--write-media", str(media)],
        check=True,
        capture_output=True,
    )
    if not media.exists() or media.stat().st_size == 0:
        raise RuntimeError("edge-tts produced no media")
    return media


def to_wav(mp3: Path) -> bytes:
    """Decode MP3 and resample to 16 kHz mono PCM16 WAV bytes."""
    pcm = bytearray()
    with av.open(str(mp3)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=TARGET_RATE)
        for frame in container.decode(stream):
            # Let the resampler own timestamps; the source ones are meaningless here.
            frame.pts = None
            for out in resampler.resample(frame):
                pcm += out.to_ndarray().tobytes()
        for out in resampler.resample(None):
            pcm += out.to_ndarray().tobytes()

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes(bytes(pcm))
    return buffer.getvalue()


def main() -> None:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "corpus")
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        work = Path(scratch)
        for label, voice, note in VOICES:
            try:
                wav = to_wav(speak(voice, TEXT, work))
                (out_dir / f"{label}.wav").write_bytes(wav)
                with wave.open(io.BytesIO(wav)) as handle:
                    seconds = handle.getnframes() / handle.getframerate()
                print(f"{label:22} {voice:32} {handle.getframerate()} Hz  {seconds:5.1f}s  # {note}")
            except Exception as error:  # noqa: BLE001 - report every failure, never abort the run
                print(f"{label:22} {voice:32} FAILED: {error}")


if __name__ == "__main__":
    main()
