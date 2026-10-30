const TEXT_PREVIEW_LAST_BYTE = 4095

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function loadFileTextPreview(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl(url, {
    headers: { range: `bytes=0-${TEXT_PREVIEW_LAST_BYTE}` },
    signal,
  })
  return response.ok ? await response.text() : undefined
}
