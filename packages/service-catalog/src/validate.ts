import { SERVICE_DEFINITIONS, validateCatalog } from './index'

const errors = validateCatalog(SERVICE_DEFINITIONS)
if (errors.length > 0) {
  for (const error of errors) console.error(`${error.serviceId}: ${error.message}`)
  process.exitCode = 1
} else {
  console.log(`service catalog is valid (${SERVICE_DEFINITIONS.length} services)`)
}
