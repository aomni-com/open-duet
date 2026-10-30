# Chrome page freeze economics and safety probe

Date: 2026-08-13T22:15:32.024Z

## Verdict

**FAIL** — Command failed (exit 1): set -euo pipefail

## Failure detail

```text
Command failed (exit 1): set -euo pipefail
cleanup_probe() { rm -f /tmp/duet-chrome-freeze-probe.py; }
trap cleanup_probe EXIT
sudo -n systemctl start duet-desktop.target
for _ in {1..600}; do
  if curl -fsS 'http://192.0.2.1:9222/json/version' >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS 'http://192.0.2.1:9222/json/version' >/dev/null
IMAGE_REF="ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd" DISPLAY=:1 python3 /tmp/duet-chrome-freeze-probe.py
Traceback (most recent call last):
  File "/tmp/duet-chrome-freeze-probe.py", line 298, in <module>
    print(json.dumps(main(), sort_keys=True))
                     ^^^^^^
  File "/tmp/duet-chrome-freeze-probe.py", line 196, in main
    page.wait_for_function("window.__duetProbe && window.__duetProbe.ticks > 4")
  File "/usr/local/lib/python3.12/dist-packages/playwright/sync_api/_generated.py", line 12761, in wait_for_function
    self._sync(
  File "/usr/local/lib/python3.12/dist-packages/playwright/_impl/_sync_base.py", line 115, in _sync
    return task.result()
           ^^^^^^^^^^^^^
  File "/usr/local/lib/python3.12/dist-packages/playwright/_impl/_page.py", line 1151, in wait_for_function
    return await self._main_frame.wait_for_function(**locals_to_params(locals()))
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/local/lib/python3.12/dist-packages/playwright/_impl/_frame.py", line 940, in wait_for_function
    await self._channel.send("waitForFunction", self._timeout, params)
  File "/usr/local/lib/python3.12/dist-packages/playwright/_impl/_connection.py", line 76, in send
    return await self._connection.wrap_api_call(
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/local/lib/python3.12/dist-packages/playwright/_impl/_connection.py", line 632, in wrap_api_call
    raise rewrite_error(error, f"{parsed_st['apiName']}: {error}") from None
playwright._impl._errors.TargetClosedError: Page.wait_for_function: Target page, context or browser has been closed

```


## Exact environment

- VM: `duet-test-chrome-freeze-20260813t221512-wtas`
- Immutable image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- Chrome: `unmeasured`
- VM shape: 2 CPU / 8 GB
- Create: 7245 ms; boot to SSH: 1104 ms
- Workload: unmeasured busy page targets in separate Chrome windows, including one popup; unmeasured ms samples

## CPU and RSS telemetry

| phase | renderer CPU cores | all Chrome CPU cores | renderer RSS | all Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
| active | unmeasured | unmeasured | unmeasured | unmeasured |
| frozen | unmeasured | unmeasured | unmeasured | unmeasured |
| thawed | unmeasured | unmeasured | unmeasured | unmeasured |

Renderer CPU reduction: unmeasured. PASS requires an active control of at least 0.25 renderer CPU cores and both a 60% and 0.20-core reduction. RSS is deliberately telemetry, not a verdict.

## Safety and thaw evidence

- Timer count before freeze / immediately after thaw / after resume: unmeasured
- DOM/JS marker survived: unmeasured
- Navigation count before / after: unmeasured
- Native-X11-focus stimulus to explicit thaw and resumed timer: unmeasured
- Target discoverable after thaw: unmeasured
- Post-thaw DOM drive observed: unmeasured

The X11 focus action is only the stimulus for this gate; it is not proposed as the production focus owner. Slice 00 gate B independently proves the extension focus/event channel.

## Promise boundary observations

- Unmeasured.

The supported promise is page-target renderer quieting via `Page.setWebLifecycleState`. It does not suspend Chrome's browser process, service workers, audio/download services, open native dialogs, or an unenumerated popup. Every owned page target must be enumerated and frozen explicitly.

## Cleanup

- Deleted: `duet-test-chrome-freeze-20260813t221512-wtas`
- Leak check: the exact probe VM no longer exists
