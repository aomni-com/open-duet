# Extension/focus probe diagnostic attempts

Date: 2026-08-13

No attempt that reached Chrome showed an install-policy failure. The sole
`ExtensionInstallForcelist` policy installed the deterministic extension and it
connected with the expected id. Failures before the retained PASS were classified
as follows:

1. **Infrastructure:** exe.dev twice returned HTTP 504 while scheduling `new`.
   Chrome never started and the exact requested VM did not remain. The complete
   command and stderr from the last occurrence are retained in
   [`2026-08-13-extension-focus-failure.txt`](2026-08-13-extension-focus-failure.txt).
2. **Probe setup:** the first CRX pack attempt redundantly used `runuser` even
   though exe.dev SSH already runs as `exedev`; Linux rejected it before Chrome
   started.
3. **Probe assertion:** an early one-process check counted Chrome renderer children
   because they inherit `--user-data-dir`. The final check reads systemd's exact
   browser `MainPID` and asserts that process has the shared profile and no
   child-process `--type` flag.
4. **Probe diagnostic API:** pinned Chrome rejected `ServiceWorker.enable` on the
   browser-level Playwright CDP session. The final proof instead observes Chrome's
   natural MV3 suspension: it closes the WebSocket after a witnessed 20-second
   keepalive, wakes at 60 seconds with a probe-only alarm, and requires a different
   module-start timestamp before accepting reconnect.

These corrections changed only the disposable oracle. They did not weaken the
forced-install, exact tab/target, native focus, reconnect, or cleanup verdicts.
