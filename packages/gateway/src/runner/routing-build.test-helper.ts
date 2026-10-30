import { readFile } from 'node:fs/promises'

const [entry, outfile, replacement] = process.argv.slice(2)
if (!entry || !outfile) throw new Error('Expected entry and output path')
const result = await Bun.build({
  entrypoints: [entry],
  target: 'bun',
  plugins: [
    {
      name: 'alias-metadata-fixture',
      setup(build) {
        build.onLoad({ filter: /\/contract\/src\/model-tiers\/index\.ts$/ }, async args => ({
          contents:
            (await readFile(args.path, 'utf8')) +
            (replacement
              ? `\nObject.assign(PROVIDER_MODEL_ALIASES['openai-frontier'], { modelName: ${JSON.stringify(replacement)} })\n`
              : ''),
          loader: 'ts',
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, 'Routing bundle failed')
await Bun.write(outfile, result.outputs[0]!)
