# Chrome page freeze economics and safety probe

Date: 2026-08-13T22:18:11.159Z

## Verdict

**FAIL** — frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores; page timers advanced while frozen

## Failure detail

```text
frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores; page timers advanced while frozen
```


## Exact environment

- VM: `duet-test-chrome-freeze-20260813t221740-t5ge`
- Immutable image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- Chrome: `Google Chrome 151.0.7922.137`
- VM shape: 2 CPU / 8 GB
- Create: 1860 ms; boot to SSH: 1115 ms
- Workload: 4 busy page targets in separate Chrome windows, including one popup; 4000 ms samples
- Confounder control: the existing gateway was stopped before the desktop target so its no-runner/no-viewer reaper could not close Chrome during the three CPU samples.

## CPU and RSS telemetry

| phase | renderer CPU cores | all Chrome CPU cores | renderer RSS | all Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
| active | 1.020 | 1.067 | 1125.2 MiB | 1997.7 MiB |
| frozen | 0.982 | 1.142 | 997.9 MiB | 1877.6 MiB |
| thawed | 1.012 | 1.030 | 776.3 MiB | 1653.8 MiB |

Renderer CPU reduction: 3.7%. PASS requires an active control of at least 0.25 renderer CPU cores and both a 60% and 0.20-core reduction. RSS is deliberately telemetry, not a verdict.

## Safety and thaw evidence

- Timer count before freeze / immediately after thaw / after resume: 89 / 129 / 137
- DOM/JS marker survived: true
- Navigation count before / after: 1 / 1
- Native-X11-focus stimulus to explicit thaw and resumed timer: 202.9 ms
- Target discoverable after thaw: true
- Post-thaw DOM drive observed: true

The X11 focus action is only the stimulus for this gate; it is not proposed as the production focus owner. Slice 00 gate B independently proves the extension focus/event channel.

## Promise boundary observations

- **dialog:** Native dialog event observed and dismissed before freeze: True; an open modal is outside this gate's safety promise.
- **download:** Download completed before freeze: True; in-flight browser-service transfer behavior is outside the page lifecycle promise.
- **media:** AudioContext state before freeze was running; audio/service processes are outside the page-renderer CPU promise.
- **popup:** Popup observed as a separate page target and explicitly frozen: True.
- **serviceWorker:** Service worker was a separate target and remained discoverable without being frozen: True.

The supported promise is page-target renderer quieting via `Page.setWebLifecycleState`. It does not suspend Chrome's browser process, service workers, audio/download services, open native dialogs, or an unenumerated popup. Every owned page target must be enumerated and frozen explicitly.

## Cleanup

- Deleted: `duet-test-chrome-freeze-20260813t221740-t5ge`
- Leak check: the exact probe VM no longer exists
