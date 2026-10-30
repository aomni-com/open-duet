/**
 * train-uploads slice 11 debug: while the staging-live harness provisions a
 * workspace VM, poll for it and snapshot the gateway journal + log so the
 * sync-loop failure is captured before harness cleanup deletes the VM.
 * Run: bunx dotenvx run -q -f .env.staging -- bun packages/exe/scripts/probe-gateway-log-capture.ts <outDir>
 */
import { ExeClient, sleep } from '@repo/exe'

const outDir = process.argv[2] ?? '/tmp'
const exe = new ExeClient({ token: process.env.EXE_TOKEN })
const deadline = Date.now() + 10 * 60 * 1000

let vmName: string | undefined
while (Date.now() < deadline && vmName === undefined) {
  const vms = await exe.list()
  vmName = vms.find(vm => vm.vm_name.startsWith('duet-ws-'))?.vm_name
  if (vmName === undefined) await sleep(5000)
}
if (vmName === undefined) throw new Error('no workspace VM appeared within 10 minutes')
console.log('capturing from', vmName)
const dest = `exedev@${vmName}.exe.xyz`

let round = 0
while (Date.now() < deadline) {
  round += 1
  try {
    const log = await exe.exec(
      dest,
      'echo ===UNITS===; systemctl --no-pager status duet-gateway 2>&1 | head -12; echo ===JOURNAL===; journalctl -u duet-gateway --no-pager -n 60 2>&1 | tail -60; echo ===GWLOG===; tail -n 80 ~/.duet/logs/gateway.log 2>/dev/null',
    )
    await Bun.write(`${outDir}/vm-capture-${String(round).padStart(2, '0')}.txt`, log.stdout)
    console.log(`round ${round}: captured ${log.stdout.length} bytes`)
  } catch (error) {
    console.log(`round ${round}: exec failed: ${String(error).slice(0, 160)}`)
  }
  await sleep(20000)
}
