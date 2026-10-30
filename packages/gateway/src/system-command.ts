export type SystemCommandRunner = (argv: string[]) => Promise<{ exitCode: number }>

export async function runSystemCommand(argv: string[]): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
  return { exitCode: await proc.exited }
}

export async function runSystemCommandOrThrow(argv: string[]): Promise<void> {
  const { exitCode } = await runSystemCommand(argv)
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} failed with exit code ${exitCode}`)
}
