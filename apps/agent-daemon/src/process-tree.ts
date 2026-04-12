export const DETACH_PROCESS_GROUP = process.platform !== 'win32'

interface KillableProcess {
  pid: number
  kill(signal?: NodeJS.Signals | number): void
}

export function killProcessTree(
  proc: KillableProcess | null | undefined,
  signal: NodeJS.Signals | number = 'SIGKILL',
): void {
  if (!proc) return

  if (DETACH_PROCESS_GROUP && Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {
      // Fall through to a direct kill when process-group signaling is unavailable.
    }
  }

  try {
    proc.kill(signal)
  } catch {
    // Ignore already-exited processes.
  }
}
