# Chrome page freeze economics and safety probe

Date: 2026-08-13T22:27:42.577Z

## Verdict

**FAIL** — frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores; page timers advanced while frozen

## Failure detail

```text
frozen renderer CPU did not fall by at least 60% and 0.20 CPU cores; page timers advanced while frozen
```


## Exact environment

- VM: `duet-test-chrome-freeze-20260813t222658-djyx`
- Immutable image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- Chrome: `Google Chrome 151.0.7922.137`
- VM shape: 2 CPU / 8 GB
- Create: 1542 ms; boot to SSH: 1118 ms
- Workload: 4 busy page targets in separate Chrome windows, including one popup; 4000 ms samples
- Confounder control: the existing gateway was stopped before the desktop target so its no-runner/no-viewer reaper could not close Chrome during the three CPU samples.

## CPU and RSS telemetry

| phase | renderer CPU cores | all Chrome CPU cores | renderer RSS | all Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
| active | 0.977 | 1.140 | 995.1 MiB | 1874.4 MiB |
| frozen | 1.012 | 1.030 | 772.8 MiB | 1649.1 MiB |
| thawed | 1.017 | 1.037 | 743.1 MiB | 1619.5 MiB |

Renderer CPU reduction: -3.6%. PASS requires an active control of at least 0.25 renderer CPU cores and both a 60% and 0.20-core reduction. RSS is deliberately telemetry, not a verdict.

## Safety and thaw evidence

- Timer count before freeze / immediately after thaw / after resume: 222 / 263 / 271
- DOM/JS marker survived: true
- Navigation count before / after: 1 / 1
- Native-X11-focus stimulus to explicit thaw and resumed timer: 209.6 ms
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

## Focus diagnostic matrix

| target condition | timer delta during 1 s freeze | visibility before / after | lifecycle events observed |
| --- | ---: | --- | --- |
| another Chrome window focused | 10 | visible / visible | none |
| target's own Chrome window focused | 10 | visible / visible | none |

This matrix is diagnosis, not an alternate PASS criterion. It distinguishes a focus-triggered auto-thaw from lifecycle freeze failing on a visible top-level page.

### Minimized-background fallback diagnostic

The foreground primary window stays active and is excluded. Three background
windows are minimized by exact Chrome `windowId`, measured, then page-frozen
while still minimized, measured again, explicitly activated/restored, and checked
for state/timer recovery.

| phase | renderer CPU cores (includes protected foreground) | all Chrome CPU cores | aggregate background timer delta |
| --- | ---: | ---: | ---: |
| minimized only | 1.010 | 1.027 | 112 |
| minimized + page frozen | 1.012 | 1.027 | 115 |

- Visibility while minimized: visible, visible, visible
- Visibility after restore: visible, visible, visible
- Chrome window states while minimized: minimized, minimized, minimized
- Chrome window states after restore: normal, normal, minimized
- Lifecycle events: none
- Restore resumed timers: true
- DOM/JS markers survived restore: true

This is fallback evidence only. The probe does not select minimize/restore as product policy.

## Cleanup

- Deleted: `duet-test-chrome-freeze-20260813t222658-djyx`
- Leak check: the exact probe VM no longer exists
