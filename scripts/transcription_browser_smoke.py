"""Check the fork's original-time chord preview alongside upstream workspaces."""
import io
import json
import wave

from playwright.sync_api import expect


def assert_transcription_preview(browser, url, output):
    page = browser.new_page(viewport={"width": 1366, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    abc = 'X:1\nT:Preview\nM:4/4\nL:1/4\nK:C\nC D E F|\n'
    job = {"id": "preview-regression", "kind": "transcribe", "status": "complete",
           "created_at": 1, "source": "webui", "result_panel": "transcription",
           "result": {"timeline": "timeline.json", "source_name": "Chord preview",
                      "abc": abc, "melody_abc_path": "score.melody.abc", "melody_only": False}}
    timeline = {"schema": 1, "duration": 2, "source_name": "Chord preview",
                "audio": "source_audio.flac", "notes": [{"start": .1, "end": .8, "pitch": 64, "track": 0}],
                "chords": [{"start": 0, "end": 2, "label": "C:maj"}],
                "keys": [{"start": 0, "end": 2, "label": "C:maj"}],
                "structures": [], "beats": [], "measures": [],
                "chord_notes": [{"pitch": p, "start": 0, "end": 2} for p in (60, 64, 67)],
                "config": {}, "warnings": [], "diagnostics": []}
    def json_route(route, value):
        route.fulfill(content_type="application/json", body=json.dumps(value))
    page.route("**/api/jobs?*", lambda route: json_route(route, {"jobs": [job], "total": 1}))
    page.route("**/api/jobs/preview-regression", lambda route: json_route(route, job))
    page.route("**/files/preview-regression/artifacts/transcription/timeline.json", lambda route: json_route(route, timeline))
    page.route("**/files/preview-regression/artifacts/transcription/waveform.json", lambda route: json_route(route, {"step": .01, "duration": 2, "peaks": [[-.1, .1]] * 200}))
    page.route("**/files/preview-regression/artifacts/transcription/*.abc", lambda route: route.fulfill(content_type="text/plain", body=abc))
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 16000)
    page.route("**/files/preview-regression/artifacts/transcription/source_audio.flac", lambda route: route.fulfill(content_type="audio/wav", body=data.getvalue()))
    page.goto(url, wait_until="domcontentloaded")
    page.locator('.tab[data-tab="transcription"]').click()
    expect(page.locator("#ss-workbench")).to_be_visible()
    expect(page.locator("#ss-title")).to_have_text("Chord preview")
    page.locator("#ss-chords button").first.click()
    expect(page.locator("#ss-note-detail")).to_contain_text("C4")
    page.wait_for_function("Number(document.querySelector('#ss-level').dataset.maxPeak) > 0")
    page.locator("#ss-test-tone").click()
    page.locator("#ss-play").click()
    page.wait_for_function("document.querySelector('#ss-audio').currentTime > .1")
    page.locator('.tab[data-tab="midi"]').click()
    assert page.evaluate("document.querySelector('#ss-audio').paused")
    page.locator('.tab[data-tab="transcription"]').click()
    page.reload(wait_until="domcontentloaded")
    expect(page.locator("#transcription")).to_have_class("panel active")
    expect(page.locator("#ss-title")).to_have_text("Chord preview")
    page.locator("#ss-to-cover").click()
    expect(page.locator("#cover-abc")).to_have_value(abc)
    page.locator('.tab[data-tab="transcription"]').click()
    page.locator("#ss-to-plan").click()
    expect(page.locator("#plan-abc")).to_have_value(abc)
    page.locator('.tab[data-tab="history"]').click()
    page.get_by_role("button", name="打开钢琴卷帘").click()
    expect(page.locator("#transcription")).to_have_class("panel active")
    page.screenshot(path=output / "transcription-desktop.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator("#mobile-workspace-menu").click()
    page.locator('[data-go-tab="transcription"]').click()
    widths = page.evaluate("({page:document.documentElement.scrollWidth,viewport:innerWidth})")
    assert widths["page"] <= widths["viewport"] + 1, widths
    page.screenshot(path=output / "transcription-phone.png", full_page=True)
    assert not errors, errors
    page.close()
