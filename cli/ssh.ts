// SSH Layer — persistent connection to VPS
// Wraps node-ssh with timeout, exit-code capture, stderr/stdout split

export interface SSHConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  remoteRepoRoot: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  elapsed: number;
}

// TODO: Implement SSH connection manager
// - Single persistent connection, reused across commands
// - Timeout + exit-code capture per command
// - Log streaming via tail -f
// - No reconnection in v1 — fail loudly
