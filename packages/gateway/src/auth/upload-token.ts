import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'

import { readPrivateJson, writePrivateJson } from './private-state'
import { uploadScopeKey, type UploadScope } from './upload-scope'

const UPLOAD_TOKENS_DIR = 'upload-tokens'

interface PersistedUploadToken {
  scope: string
  sha256: string
  expiresAt: number
}

export class UploadTokenCredential {
  constructor(private readonly stateDir: string) {}

  async mint(
    scope: UploadScope,
    now: number,
    ttl: number,
  ): Promise<{ token: string; expiresAt: number }> {
    if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) {
      throw new Error('upload token now and ttl must be finite, with ttl greater than zero')
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + ttl
    await persistUploadToken(this.stateDir, scope, {
      scope: uploadScopeKey(scope),
      sha256: hashToken(token),
      expiresAt,
    })
    return { token, expiresAt }
  }

  async verify(scope: UploadScope, token: string, now: number): Promise<boolean> {
    const persisted = await readUploadToken(this.stateDir, scope)
    if (
      persisted === null ||
      persisted.scope !== uploadScopeKey(scope) ||
      now >= persisted.expiresAt
    ) {
      return false
    }
    const actual = Buffer.from(hashToken(token), 'hex')
    const expected = Buffer.from(persisted.sha256, 'hex')
    return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected)
  }
}

async function persistUploadToken(
  stateDir: string,
  scope: UploadScope,
  credential: PersistedUploadToken,
): Promise<void> {
  const tokensDir = resolve(stateDir, UPLOAD_TOKENS_DIR)
  await writePrivateJson(tokensDir, `${uploadScopeKey(scope)}.json`, credential, 'upload-token')
}

async function readUploadToken(
  stateDir: string,
  scope: UploadScope,
): Promise<PersistedUploadToken | null> {
  const parsed = (await readPrivateJson(
    resolve(stateDir, UPLOAD_TOKENS_DIR, `${uploadScopeKey(scope)}.json`),
  )) as Partial<PersistedUploadToken> | null
  if (
    parsed === null ||
    typeof parsed.scope !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
    typeof parsed.expiresAt !== 'number' ||
    !Number.isFinite(parsed.expiresAt)
  ) {
    return null
  }
  return { scope: parsed.scope, sha256: parsed.sha256, expiresAt: parsed.expiresAt }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
