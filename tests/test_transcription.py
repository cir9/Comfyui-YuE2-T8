import copy
import io
import json
import math
import tempfile
import unittest
import wave
from array import array
from pathlib import Path

from app.yue2_app.config import ROOT
from app.yue2_app.service import Handler
from app.yue2_app.transcription_data import (
    interval_data, prepare_audio, timeline_data, validate_transcription_request,
)


class TranscriptionTests(unittest.TestCase):
    def test_request_does_not_accept_truthy_strings_or_invalid_cropping(self):
        validate_transcription_request({"melody_only": False, "max_seconds": None})
        for bad in ({"melody_only": "false"}, {"workbench": 1}, {"dtype": "fp16"},
                    {"max_seconds": True}, {"max_seconds": float("nan")}, {"max_seconds": -1}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_transcription_request(bad)

    def test_timeline_preserves_unquantized_notes_and_variable_beat_times(self):
        result = {"duration_seconds": 2.7, "events": [
            {"time": .113, "values": {"melody": [{"pitch": 64, "track": 0, "end_time": .831}]}},
            {"time": .617, "values": {"melody": [{"pitch": 60, "track": 1, "end_time": 2.8}]}}],
            "labs": {"beat": "0.113\t1\t4\t4\n0.617\t2\t4\t4\n1.203\t3\t4\t4\n",
                     "chord": "0.0\t0.5\tN\n0.5\t2.7\tC:maj/3\n", "key": "0\t2.7\tC:maj\n"},
            "playback": {"tracks": [{"name": "Chords", "notes": [{"pitch": 40, "start": .5, "end": 2.7}]}]}}
        original = copy.deepcopy(result)
        data = timeline_data(result, "test.wav")
        self.assertEqual(result, original)
        self.assertEqual(data["time_unit"], "seconds")
        self.assertEqual(data["notes"][0]["start"], .113)
        self.assertEqual(data["notes"][0]["end"], .831)
        self.assertEqual(data["notes"][1]["end"], 2.7)
        self.assertEqual([b["time"] for b in data["beats"]], [.113, .617, 1.203])
        self.assertEqual(data["chords"][1]["label"], "C:maj/3")
        self.assertEqual(data["chord_notes"][0]["pitch"], 40)

    def test_empty_annotations_and_clipped_intervals(self):
        self.assertEqual(interval_data("", 1), [])
        self.assertEqual(interval_data("-1 3 C:maj\n3 4 N", 2), [{"start": 0.0, "end": 2, "label": "C:maj"}])

    def test_audio_waveform_keeps_start_time_and_duration(self):
        ffmpeg = ROOT / "runtime" / "ffmpeg" / "ffmpeg.exe"
        if not ffmpeg.is_file():
            self.skipTest("Bundled FFmpeg is not installed")
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            directory = Path(directory)
            source = directory / "input.wav"
            values = array('h', [0 if i < 12000 else int(math.sin(2 * math.pi * 440 * i / 24000) * 16000) for i in range(24000)])
            with wave.open(str(source), "wb") as stream:
                stream.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                stream.writeframes(values.tobytes())
            before = source.read_bytes()
            prepare_audio(ffmpeg, source, directory, .75, lambda: None)
            data = json.loads((directory / "waveform.json").read_text())
            self.assertEqual(source.read_bytes(), before)
            self.assertAlmostEqual(data["duration"], .75)
            self.assertEqual(data["step"], .01)
            self.assertEqual(len(data["peaks"]), 75)
            self.assertEqual(data["peaks"][:49], [[0, 0]] * 49)
            self.assertGreater(data["peaks"][55][1], .4)
            self.assertTrue((directory / "source_audio.flac").stat().st_size > 1000)

    def test_media_ranges_support_seeking_and_reject_invalid_ranges(self):
        class Response:
            def __init__(self, requested):
                self.headers = {} if requested is None else {"Range": requested}
                self.wfile = io.BytesIO()
                self.response_headers = {}
            def send_response(self, code): self.code = code
            def send_header(self, key, value): self.response_headers[key] = value
            def end_headers(self): pass

        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "audio.flac"
            path.write_bytes(b"0123456789")
            for requested, status, content in [(None, 200, b"0123456789"), ("bytes=2-5", 206, b"2345"),
                    ("bytes=8-", 206, b"89"), ("bytes=-3", 206, b"789"), ("bytes=9-50", 206, b"9"),
                    ("bytes=10-", 416, b""), ("bytes=-0", 416, b""), ("bytes=5-2", 416, b""),
                    ("bytes=0-1,3-4", 416, b"")]:
                with self.subTest(requested=requested), path.open('rb') as stream:
                    response = Response(requested)
                    Handler._stream_artifact(response, path, stream)
                    self.assertEqual(response.code, status)
                    self.assertEqual(response.wfile.getvalue(), content)
                    self.assertEqual(response.response_headers["Content-Length"], str(len(content)))
                    if status == 206:
                        self.assertTrue(response.response_headers["Content-Range"].endswith('/10'))


if __name__ == "__main__":
    unittest.main()
