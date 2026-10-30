// Build Output API entry. Bundling keeps monorepo TypeScript resolution out of
// the Node runtime; the generated .vc-config.json owns response streaming.
import app from './index.js'

export default app
