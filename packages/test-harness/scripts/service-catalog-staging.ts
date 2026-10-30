import { runServiceCatalogStagingJourney } from '../src/service-catalog-staging.ts'

try {
  const evidence = await runServiceCatalogStagingJourney()
  console.log(`SERVICE_CATALOG_STAGING_EVIDENCE ${JSON.stringify(evidence)}`)
} catch (error) {
  console.error(
    `SERVICE_CATALOG_STAGING_FAILED ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
