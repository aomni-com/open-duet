export async function generateTitleWithTimeout(
  generate: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    return await generate(AbortSignal.timeout(timeoutMs))
  } catch {
    return undefined
  }
}
