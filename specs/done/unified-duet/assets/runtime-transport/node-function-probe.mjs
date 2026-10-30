import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const functionDir = resolve(process.argv[2])
const { createApiApp } = await import(pathToFileURL(join(functionDir,'index.mjs')).href)
const release = join(functionDir,'runtime-release')
const manifest = JSON.parse(await readFile(join(release,'manifest.json'),'utf8'))
const token='REDACTED'
const tokenHash=createHash('sha256').update(token).digest('hex')
const app=createApiApp({
  convexUrl:'http://192.0.2.1:3210',internalKey:'fixture-internal',runtimeReleaseDir:release,
  convexClient:{async query(_fn,args) { return args.vmTokenHash===tokenHash ? {workspaceId:'node-fixture',vmName:'node-fixture'}:null }},
})
assert.equal((await app.request('/v1/vm/runtime-release/manifest')).status,401)
const headers={authorization:`Bearer ${token}`}
const response=await app.request('/v1/vm/runtime-release/manifest',{headers})
assert.equal(response.status,200)
assert.deepEqual(await response.json(),manifest)
for(const artifact of manifest.artifacts) {
  const response=await app.request(`/v1/vm/runtime-release/artifacts/${artifact.name}`,{headers})
  assert.equal(response.status,200)
  assert.equal(response.headers.get('content-length'),String(artifact.byteLength))
  const bytes=Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.byteLength,artifact.byteLength)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256)
  assert.equal((await stat(join(release,artifact.name))).mode&0o777,artifact.mode)
}
console.log(JSON.stringify({node:process.version,version:manifest.version,actualBundledNodeTransport:'PASS all artifact bytes + mode/length/hash + unauthenticated rejection',backend:'controlled query fixture; real Convex authentication covered separately'}))
