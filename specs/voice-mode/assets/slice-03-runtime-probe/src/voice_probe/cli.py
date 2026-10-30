import argparse
import asyncio
import json
import os
import secrets
import subprocess
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

from voice_probe.browser_codecs import probe_chromium_codec
from voice_probe.browser_runtime import BrowserProbePage
from voice_probe.cloud_sample import (
    provider_room_name,
    required_credentials,
    run_chromium_cloud_sample,
    run_cloud_sample_with_browser,
)
from voice_probe.fake_mcp import run_fake_bound_server
from voice_probe.matrix import (
    PlannedAttempt,
    capture_attempt,
    closure_report,
    parse_manifest,
    planned_attempts,
)
from voice_probe.measurements import summarize
from voice_probe.mobile_controller import MobileProbeServer, launch_quick_tunnel
from voice_probe.ogg_opus import encode_fixture_pair, normalize_spoken_source


def main() -> None:
    parser = argparse.ArgumentParser(description="Duet Voice Slice 03 evidence probe")
    subparsers = parser.add_subparsers(dest="command", required=True)

    fixtures = subparsers.add_parser("fixtures")
    fixtures.add_argument("--output", type=Path, required=True)
    fixtures.add_argument("--source", type=Path, required=True)

    source_fixture = subparsers.add_parser("source-fixture")
    source_fixture.add_argument("--input", type=Path, required=True)
    source_fixture.add_argument("--output", type=Path, required=True)

    codecs = subparsers.add_parser("chromium-codecs")
    codecs.add_argument("--chrome", type=Path, required=True)
    codecs.add_argument("--fixture", type=Path, required=True)
    codecs.add_argument("--output", type=Path, required=True)

    summary = subparsers.add_parser("summarize")
    summary.add_argument("--input", type=Path, required=True)
    summary.add_argument("--output", type=Path, required=True)

    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--output", type=Path, required=True)

    fake_mcp = subparsers.add_parser("fake-mcp")
    fake_mcp.add_argument("--port", type=int, default=8765)

    cloud = subparsers.add_parser("cloud-matrix")
    cloud.add_argument("--manifest", type=Path, required=True)
    cloud.add_argument("--output", type=Path, required=True)
    cloud.add_argument("--report", type=Path, required=True)
    cloud.add_argument("--cold-activation-script", type=Path, required=True)
    cloud.add_argument("--chrome", type=Path, required=True)
    cloud.add_argument("--cloudflared", type=Path, required=True)
    cloud.add_argument("--browser-bundle", type=Path, required=True)
    cloud.add_argument("--fixture", type=Path, required=True)

    args = parser.parse_args()
    if args.command == "fixtures":
        output: Path = args.output
        evidence = encode_fixture_pair(
            full_path=output / "four-second.ogg",
            prefix_path=output / "heard-prefix-1.2s.ogg",
            source_path=args.source,
        )
        _write_json(output / "fixture-evidence.json", evidence)
    elif args.command == "source-fixture":
        normalize_spoken_source(input_path=args.input, output_path=args.output)
    elif args.command == "chromium-codecs":
        _write_json(
            args.output,
            probe_chromium_codec(executable=args.chrome, fixture=args.fixture),
        )
    elif args.command == "summarize":
        samples = [json.loads(line) for line in args.input.read_text().splitlines() if line]
        _write_json(args.output, summarize(samples))
    elif args.command == "doctor":
        required = (
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "LIVEKIT_FISH_STOCK_VOICE_ID_3",
        )
        _write_json(
            args.output,
            {
                "cloud_probe_ready": all(os.environ.get(name) for name in required),
                "required_environment_names": list(required),
                "third_stock_voice_ready": bool(os.environ.get("LIVEKIT_FISH_STOCK_VOICE_ID_3")),
                "required_stock_voice_count": 3,
            },
        )
    elif args.command == "fake-mcp":
        run_fake_bound_server(args.port)
    elif args.command == "cloud-matrix":
        manifest = parse_manifest(json.loads(args.manifest.read_text()))
        required_credentials()

        async def collect() -> None:
            mobile_secret = secrets.token_hex(32)
            async with (
                MobileProbeServer.from_bundle(
                    args.browser_bundle, secret=mobile_secret
                ) as mobile_server,
                launch_quick_tunnel(
                    executable=args.cloudflared,
                    local_url=mobile_server.local_url,
                ) as public_url,
            ):
                print(
                    "Open this one-time URL in mobile Safari and tap Arm mobile "
                    f"probe:\n{public_url}/#secret={mobile_secret}",
                    flush=True,
                )
                mobile_browser = await mobile_server.wait_for_browser(timeout=300)
                args.output.parent.mkdir(parents=True, exist_ok=True)
                rows: list[dict[str, object]] = []
                with args.output.open("w") as output:
                    for attempt in planned_attempts(manifest):
                        sample_id = secrets.token_hex(8)

                        row = await capture_attempt(
                            attempt,
                            sample_id=sample_id,
                            run=partial(
                                _run_cloud_attempt,
                                attempt=attempt,
                                sample_id=sample_id,
                                cold_activation_script=args.cold_activation_script,
                                chrome=args.chrome,
                                browser_bundle=args.browser_bundle,
                                fixture=args.fixture,
                                mobile_browser=mobile_browser,
                            ),
                        )
                        absence_verified = await asyncio.to_thread(
                            _confirm_provider_absence,
                            attempt.attempt_id,
                            provider_room_name(sample_id),
                        )
                        row["privacy"] = {
                            "record_false": True,
                            "cloud_absence_verified": absence_verified,
                        }
                        rows.append(row)
                        output.write(json.dumps(row, sort_keys=True) + "\n")
                        output.flush()
                _write_json(args.report, closure_report(manifest, rows))

        asyncio.run(collect())


async def _run_cloud_attempt(
    *,
    attempt: PlannedAttempt,
    sample_id: str,
    cold_activation_script: Path,
    chrome: Path,
    browser_bundle: Path,
    fixture: Path,
    mobile_browser: BrowserProbePage,
) -> dict[str, object]:
    if attempt.activation_state == "cold":
        await asyncio.to_thread(
            subprocess.run,
            [str(cold_activation_script.resolve())],
            check=True,
        )
    if attempt.browser_floor == "chromium-desktop":
        return await run_chromium_cloud_sample(
            sample_id=sample_id,
            candidate_id=attempt.candidate_id,
            candidate=attempt.candidate,
            activation_state=attempt.activation_state,
            browser_floor=attempt.browser_floor,
            chrome=chrome,
            browser_bundle=browser_bundle,
            fixture=fixture,
            scenario=attempt.scenario,
        )
    return await run_cloud_sample_with_browser(
        browser=mobile_browser,
        sample_id=sample_id,
        candidate_id=attempt.candidate_id,
        candidate=attempt.candidate,
        activation_state=attempt.activation_state,
        browser_floor=attempt.browser_floor,
        fixture=fixture,
        scenario=attempt.scenario,
    )


def _confirm_provider_absence(
    attempt_id: str,
    provider_room: str,
    *,
    read: Callable[[str], str] = input,
) -> bool:
    try:
        response = read(
            "Check Agent Insights or the provider API for this completed attempt. "
            f"Search for provider-visible room {provider_room}. Confirm it contains "
            "no uploaded audio, transcript, trace, or log by typing the room and "
            f"exact local attempt ID:\n{provider_room} {attempt_id}\n> "
        )
    except EOFError:
        return False
    return response.strip() == f"{provider_room} {attempt_id}"


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
