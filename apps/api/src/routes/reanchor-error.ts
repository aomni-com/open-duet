export function isReanchorRequestError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /not broken|path already exists|Invalid anchor path|Replica app anchors cannot be reanchored/.test(
      error.message,
    )
  )
}
