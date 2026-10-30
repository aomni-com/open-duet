import actionRetrier from '@convex-dev/action-retrier/convex.config'
import batchWorker from '@convex-dev/batch-worker/convex.config'
import migrations from '@convex-dev/migrations/convex.config'
import { defineApp } from 'convex/server'

const app = defineApp()
app.use(actionRetrier)
app.use(batchWorker, { name: 'billingWorker', env: {} })
app.use(migrations)

export default app
