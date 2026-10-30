import { demo60sProbeCanRun, runDemo60sProbe } from '../src/demo-60s.ts'

if (!demo60sProbeCanRun()) {
  console.log(
    'SLICEDEMO-9K4T_SKIPPED requires EXE_TOKEN, DUET_REAL_VM_IMAGE_REF, RUN_DOCKER_TESTS=1, and a reachable Docker daemon.',
  )
  process.exit(0)
}

const result = await runDemo60sProbe()
console.log(JSON.stringify(result, null, 2))
