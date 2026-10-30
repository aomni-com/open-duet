export type ShareSyncMode = 'read' | 'write'
export type ShareSyncRole = 'origin' | 'recipient'

/** One-writer topology for read shares; write shares remain bidirectional. */
export function shareSyncthingFolderType(
  mode: ShareSyncMode,
  role: ShareSyncRole,
): 'sendonly' | 'receiveonly' | 'sendreceive' {
  if (mode === 'write') return 'sendreceive'
  return role === 'origin' ? 'sendonly' : 'receiveonly'
}
