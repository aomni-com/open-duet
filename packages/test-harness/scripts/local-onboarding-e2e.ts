import { runLocalOnboardingE2e } from '../src/local-onboarding-e2e.ts'

try {
  const result = await runLocalOnboardingE2e()
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
