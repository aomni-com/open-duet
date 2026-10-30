# Initial KasmVNC transport probe

Date: 2026-08-11

Disposable VM `duet-kasm-probe` ran Ubuntu 24.04 on two vCPUs and was deleted
after the measurement.

- KasmVNC 1.5.0 served both its web client and pixel stream on port 6901.
  Unauthenticated HTTP returned 401 and authenticated HTTP returned 200.
- Fixed configuration produced exactly 1440×900.
- Xvnc CPU, sampled from `/proc` jiffies over three 20-second windows, measured
  0% with no viewer, 0% with a viewer on a static screen, and 3.5% of one core
  while a full-screen page scrolled continuously.
- The desktop stack without Chrome used approximately 346 MB RSS: Xvnc 152 MB,
  xfdesktop 68 MB, xfwm4 43 MB, Plank 39 MB, xfsettingsd 29 MB, and devilspie2
  15 MB.
- Shared-profile Chrome worked over loopback CDP without
  `--remote-allow-origins`.

The probe also established three packaging constraints retained by the image:
invoke `/usr/bin/kasmvncserver` by its absolute packaged path; provide a
Duet-owned readable TLS keypair even when `require_ssl` is false; and treat
`-select-de` as the owner of `~/.vnc/xstartup` because it overwrites that file.
