// One byte formatter for the whole SPA. Base is explicit at the call site
// because it is a real domain choice, not a default: the train uploads cap is
// binary (1024³ = TRAIN_UPLOADS_CAP_BYTES) so its sizes read in binary units;
// the files surfaces render decimal. Two hand-rolled copies drifting apart is
// exactly what this replaces.
export function formatBytes(bytes: number, base: 1000 | 1024): string {
  if (bytes < base) return `${bytes} B`
  // Binary KB rounds whole (matches the uploads staging list); decimal keeps one.
  if (bytes < base * base) return `${(bytes / base).toFixed(base === 1024 ? 0 : 1)} KB`
  if (bytes < base * base * base) return `${(bytes / (base * base)).toFixed(1)} MB`
  return `${(bytes / (base * base * base)).toFixed(1)} GB`
}
