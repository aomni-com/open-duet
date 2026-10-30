import base64
from pathlib import Path
from typing import TypedDict

from playwright.sync_api import sync_playwright


class BrowserCodecEvidence(TypedDict):
    browser: str
    browser_version: str
    mime: str
    media_recorder_supported: bool
    media_recorder_capture_completed: bool
    can_play_type: str
    fixture_duration_ms: int
    acknowledged_playout_ms: int
    playout_wall_ms: int


def probe_chromium_codec(*, executable: Path, fixture: Path) -> BrowserCodecEvidence:
    fixture_url = "data:audio/ogg;base64," + base64.b64encode(fixture.read_bytes()).decode()
    mime = "audio/ogg;codecs=opus"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(executable),
            headless=True,
            args=["--autoplay-policy=no-user-gesture-required"],
        )
        try:
            page = browser.new_page()
            result = page.evaluate(
                """
                async ({fixtureUrl, mime}) => {
                  const audio = new Audio(fixtureUrl);
                  const loaded = new Promise((resolve, reject) => {
                    audio.addEventListener('loadedmetadata', resolve, {once: true});
                    audio.addEventListener(
                      'error',
                      () => reject(new Error('fixture decode failed')),
                      {once: true},
                    );
                  });
                  await loaded;

                  const recorderSupported = MediaRecorder.isTypeSupported(mime);
                  let captureCompleted = false;
                  if (recorderSupported) {
                    const context = new AudioContext();
                    const oscillator = context.createOscillator();
                    const destination = context.createMediaStreamDestination();
                    oscillator.connect(destination);
                    const recorder = new MediaRecorder(destination.stream, {mimeType: mime});
                    const chunks = [];
                    recorder.addEventListener('dataavailable', event => chunks.push(event.data));
                    const stopped = new Promise(resolve => {
                      recorder.addEventListener('stop', resolve, {once: true});
                    });
                    oscillator.start();
                    recorder.start();
                    await new Promise(resolve => setTimeout(resolve, 200));
                    recorder.stop();
                    oscillator.stop();
                    await stopped;
                    captureCompleted = new Blob(chunks, {type: mime}).size > 0;
                    await context.close();
                  }

                  const playoutStartedAt = performance.now();
                  await audio.play();
                  while (audio.currentTime < 1.2) {
                    await new Promise(resolve => setTimeout(resolve, 5));
                  }
                  audio.pause();
                  return {
                    mediaRecorderSupported: recorderSupported,
                    mediaRecorderCaptureCompleted: captureCompleted,
                    canPlayType: audio.canPlayType(mime),
                    fixtureDurationMs: Math.round(audio.duration * 1000),
                    acknowledgedPlayoutMs: Math.round(audio.currentTime * 1000),
                    playoutWallMs: Math.round(performance.now() - playoutStartedAt),
                  };
                }
                """,
                {"fixtureUrl": fixture_url, "mime": mime},
            )
            return BrowserCodecEvidence(
                browser="Google Chrome",
                browser_version=browser.version,
                mime=mime,
                media_recorder_supported=result["mediaRecorderSupported"],
                media_recorder_capture_completed=result["mediaRecorderCaptureCompleted"],
                can_play_type=result["canPlayType"],
                fixture_duration_ms=result["fixtureDurationMs"],
                acknowledged_playout_ms=result["acknowledgedPlayoutMs"],
                playout_wall_ms=result["playoutWallMs"],
            )
        finally:
            browser.close()
