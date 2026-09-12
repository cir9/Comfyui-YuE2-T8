"""Portable, original-time inspection data for SheetSage2 results."""
from __future__ import annotations

import math
import subprocess
import tempfile
import time
from pathlib import Path

from .io import atomic_json


def validate_transcription_request(request: dict) -> None:
    for name in ("melody_only", "render_audio", "workbench"):
        if name in request and type(request[name]) is not bool:
            raise ValueError(f"{name} 必须是布尔值")
    if request.get("dtype", "bf16") not in {"bf16", "fp32"}:
        raise ValueError("转谱精度必须为 bf16 或 fp32")
    if request.get("preset", "default") not in {"default", "paper"}:
        raise ValueError("转谱预设必须为 default 或 paper")
    seconds = request.get("max_seconds")
    if seconds is not None and (type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0):
        raise ValueError("转谱时长必须是大于 0 的有限秒数，留空则处理全曲")


def interval_data(text: str, duration: float) -> list[dict]:
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        a, b, label = line.split(maxsplit=2)
        a, b = max(0.0, float(a)), min(duration, float(b))
        if b > a:
            rows.append({"start": a, "end": b, "label": label})
    return rows


def timeline_data(result: dict, source_name: str) -> dict:
    duration = float(result["duration_seconds"])
    notes = []
    for event in result["events"]:
        for note in event["values"].get("melody", []):
            a, b = max(0.0, float(event["time"])), min(duration, float(note["end_time"]))
            if b > a:
                notes.append({"start": a, "end": b, "pitch": int(note["pitch"]),
                              "track": int(note["track"])})
    labs = result["labs"]
    beats = []
    for row in labs.get("beat", "").splitlines():
        t, beat, numerator, denominator = row.split()
        beats.append({"time": float(t), "beat": int(beat),
                      "numerator": int(numerator), "denominator": int(denominator)})
    playback = result.get("playback", {})
    return {"schema": 1, "source_name": source_name, "duration": duration,
            "audio": "source_audio.flac", "waveform": "waveform.json", "time_unit": "seconds",
            "notes": sorted(notes, key=lambda n: (n["start"], n["track"], n["pitch"])),
            "chords": interval_data(labs.get("chord", ""), duration),
            "keys": interval_data(labs.get("key", ""), duration),
            "structures": interval_data(labs.get("structure", ""), duration), "beats": beats,
            "measures": playback.get("measures", []),
            "chord_notes": [note for track in playback.get("tracks", [])
                            if track["name"].lower() == "chords" for note in track["notes"]],
            "config": {key: result.get(key) for key in (
                "prompts", "preset", "dtype", "melody_only", "window_seconds", "overlap_seconds", "lookahead_seconds")},
            "warnings": result.get("warnings", []), "diagnostics": result.get("diagnostics", []),
            "abc_error": result.get("abc_error")}


def prepare_audio(ffmpeg: Path, source: Path, output: Path, duration: float, check_cancelled) -> None:
    # Preserve the original mix as lossless browser-readable audio. It lives with
    # the artifact, so upload retention cannot break historical playback.
    command = [str(ffmpeg), "-v", "error", "-nostdin", "-y", "-i", str(source),
               "-map", "0:a:0", "-vn", "-t", str(duration), "-c:a", "flac", str(output / "source_audio.flac")]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=errors,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            started = time.monotonic()
            while process.poll() is None:
                check_cancelled()
                if time.monotonic() - started > 600:
                    raise RuntimeError("原曲试听文件准备超时")
                time.sleep(.1)
            if process.returncode:
                errors.seek(0)
                raise RuntimeError("原曲解码失败：" + errors.read().decode(errors="replace")[-1200:])
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    import numpy as np
    rate, block = 24000, 240
    command = [str(ffmpeg), "-v", "error", "-nostdin", "-i", str(output / "source_audio.flac"),
               "-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1"]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        peaks, pending, samples = [], b"", 0
        try:
            while True:
                check_cancelled()
                data = process.stdout.read(block * 4 * 100)
                if not data:
                    break
                pending += data
                count = len(pending) // (block * 4) * block * 4
                if count:
                    values = np.frombuffer(pending[:count], dtype="<f4").reshape(-1, block)
                    if not np.isfinite(values).all():
                        raise ValueError("原曲波形含非有限数值")
                    peaks.extend(np.stack((values.min(axis=1), values.max(axis=1)), axis=1).round(5).tolist())
                    samples += count // 4
                    pending = pending[count:]
            if pending:
                values = np.frombuffer(pending, dtype="<f4")
                peaks.append([round(float(values.min()), 5), round(float(values.max()), 5)])
                samples += len(values)
            if process.wait(timeout=60):
                errors.seek(0)
                raise RuntimeError("波形提取失败：" + errors.read().decode(errors="replace")[-1200:])
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
    atomic_json(output / "waveform.json", {"schema": 1, "step": block / rate,
                "duration": samples / rate, "channels": "mono", "peaks": peaks})


def prepare_workbench(root: Path, source: Path, output: Path, result: dict, check_cancelled) -> Path:
    prepare_audio(root / "runtime" / "ffmpeg" / "ffmpeg.exe", source, output,
                  float(result["duration_seconds"]), check_cancelled)
    destination = output / "timeline.json"
    atomic_json(destination, timeline_data(result, source.name))
    return destination
