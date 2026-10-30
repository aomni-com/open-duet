/** Files the compiled CLI loads beside its executable. */
export const PGLITE_RUNTIME_ASSET_NAMES = [
  'pglite.data',
  'pglite.wasm',
  'initdb.wasm',
  'vector.tar.gz',
] as const
export const DUET_RUNTIME_ASSET_NAMES = [
  ...PGLITE_RUNTIME_ASSET_NAMES,
  'photon_rs_bg.wasm',
] as const
export type DuetRuntimeAssetName = (typeof DUET_RUNTIME_ASSET_NAMES)[number]
