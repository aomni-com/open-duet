const PROBE_RESULTS_DIR = new URL('../probe-results/', import.meta.url)

export const PROBE_REPORTS_DIR = new URL('reports/', PROBE_RESULTS_DIR)
export const PROBE_SCREENSHOTS_DIR = new URL('screenshots/', PROBE_RESULTS_DIR)
export const PROBE_TRANSCRIPTS_DIR = new URL('transcripts/', PROBE_RESULTS_DIR)

export function probeReportUrl(filename: string): URL {
  return new URL(filename, PROBE_REPORTS_DIR)
}

export function probeScreenshotUrl(filename: string): URL {
  return new URL(filename, PROBE_SCREENSHOTS_DIR)
}

export function probeTranscriptUrl(filename: string): URL {
  return new URL(filename, PROBE_TRANSCRIPTS_DIR)
}
