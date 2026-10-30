/** Quote one POSIX shell token. */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function sshExitCode(error: unknown): number {
  if (!error) return 0
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : 1
}
