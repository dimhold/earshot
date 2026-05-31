"""
Local speech-to-text sidecar for earshot.

Runs faster-whisper (CTranslate2) on this machine and transcribes discrete
utterances handed to it by the Node process. Nothing is sent anywhere: once the
model weights are on disk the sidecar needs no network at all.

Protocol
--------
Node -> Python  (binary, on stdin):
    Repeated frames. Each frame is:
        4 bytes  little-endian uint32  N   (payload length in bytes)
        N bytes  PCM, 16-bit signed LE, mono, 16 kHz
    A frame with N == 0 is ignored (keep-alive).

Python -> Node  (text, on stdout, one JSON object per line):
    {"ready": true, "model": "base.en"}        once, after the model loads
    {"seq": <int>, "text": "..."}              one per transcribed frame
    {"seq": <int>, "error": "..."}             if that frame could not be done
Diagnostics go to stderr.

Frames are processed strictly in order, so `seq` simply counts frames starting
at 0 and Node uses it to match a result to the caller waiting for it.
"""

import argparse
import json
import struct
import sys

import numpy as np

SAMPLE_MAX = 32768.0


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def read_exact(stream, n):
    """Read exactly n bytes, or return None at EOF."""
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def parse_args():
    parser = argparse.ArgumentParser(description="earshot local transcription sidecar")
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument(
        "--language",
        default="en",
        help="two letter language code, or 'auto' to let the model detect it",
    )
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="disable the model's own Silero VAD filter (earshot already segments)",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    language = None if args.language.lower() in ("auto", "") else args.language

    log(
        f"loading faster-whisper model='{args.model}' device='{args.device}' "
        f"compute_type='{args.compute_type}' (the first run downloads the weights)"
    )

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    log("model loaded.")

    out = sys.stdout
    out.write(json.dumps({"ready": True, "model": args.model}) + "\n")
    out.flush()

    stdin = sys.stdin.buffer
    seq = 0

    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break  # Node closed the pipe, so shut down.
        (length,) = struct.unpack("<I", header)
        if length == 0:
            continue
        payload = read_exact(stdin, length)
        if payload is None:
            break

        current = seq
        seq += 1

        # PCM16LE -> float32 in [-1, 1], which is what faster-whisper expects.
        audio = np.frombuffer(payload, dtype=np.int16).astype(np.float32) / SAMPLE_MAX

        try:
            segments, _info = model.transcribe(
                audio,
                language=language,
                beam_size=args.beam_size,
                vad_filter=not args.no_vad,
                condition_on_previous_text=False,
                temperature=0.0,
                no_speech_threshold=0.6,
            )
            text = "".join(segment.text for segment in segments).strip()
            message = {"seq": current, "text": text}
        except Exception as exc:  # one bad frame must never kill the sidecar
            log(f"transcribe error on seq={current}: {exc}")
            message = {"seq": current, "error": str(exc)}

        out.write(json.dumps(message) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
