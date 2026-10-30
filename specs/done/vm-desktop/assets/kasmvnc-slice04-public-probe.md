# Public desktop stack probe

Date: 2026-08-12T13:57:13.034Z

## Verdict

works: the public gateway delivered an exact 1440x900 KasmVNC desktop with live input.

## Evidence

- VM: `duet-test-desktop-stack-20260812t135208-0qbw`
- Image: `ghcr.io/aomni-com/duet-vm-image:probe-vm-desktop-s04-019ff5b3-02`
- Base image: `ghcr.io/boldsoftware/exeuntu@sha256:77b1187c8329a8c38f6f02ccf3d0f1fdf75262d2f1017d2e321140409ef215d1`
- Control-plane create: 2400 ms
- Boot to SSH: 1197 ms
- In-VM KasmVNC start to rendered framebuffer: 4156 ms
- Cold create to desktop ready: 9002 ms
- Display: 1440x900 pixels (381x238 millimeters)
- Image content size: 2178.6 MiB
- Base content size: 1479.1 MiB
- Desktop image delta: 699.5 MiB
- Framebuffer: 589060 bytes, SHA-256 `6f0c43b721bc624c93a89a01bb92f00f3ad12a9e52e09b1906b3b2cb95c6ea35`
- Public origin: https://service.example.invalid
- Public canvas: 1440x900, nonuniform pixels
- Browser input: keyboard and pointer observed by xev
- Clipboard: browser→VM passed; VM→browser passed
- Window movement: passed
- Static public connection: 260002 ms; 1 socket(s), 0 close(s)
- Scroll workload Xvnc CPU: 5.70% of one core
- Demand stop after detach: passed
- Deleted: `duet-test-desktop-stack-20260812t135208-0qbw`
- Leak check: no `duet-test-*` VMs remain

The size values are Docker's local `.Size` values for the two exact amd64 refs
above. On Docker Desktop's containerd image store they correspond to the content
size shown by `docker image ls --tree`; they are not live disk use inside a VM.

## Contract proof

```
HTTP listener=192.0.2.1:6901
xdpyinfo=1440x900 pixels (381x238 millimeters)
framebuffer=6f0c43b721bc624c93a89a01bb92f00f3ad12a9e52e09b1906b3b2cb95c6ea35
Xvnc argv contains -DLP_ClipSendMax 16777216
Xvnc argv contains -DLP_ClipAcceptMax 16777216
public websocket=1 opened / 0 closed
systemctl target reaped=true
```
