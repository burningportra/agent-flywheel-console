/**
 * test/helpers/ssh-loopback.ts
 *
 * Reusable loopback SSH server built on the ssh2 package's Server API.
 * No sshd required, no root, no system daemon. Pure-JS server that speaks
 * the real SSH protocol over TCP on a random loopback port.
 *
 * Design goals:
 *  - Each call to startLoopbackSsh() creates an independent server instance
 *    on a fresh OS-assigned port, suitable for parallel test isolation.
 *  - Command execution runs via child_process.exec in the test process's
 *    working directory so tests can assert on real command output.
 *  - The server accepts any client public key so tests don't need to
 *    coordinate key fingerprints — the generated key pair is self-consistent.
 *  - Temp directories and key files are cleaned up on stop().
 *
 * Usage:
 *   import { startLoopbackSsh } from '../helpers/ssh-loopback.js';
 *
 *   let srv: LoopbackSshServer;
 *   beforeEach(async () => { srv = await startLoopbackSsh(); });
 *   afterEach(async () => { await srv.stop(); });
 *
 *   // Use srv.sshConfigPath with SSHManager:
 *   const mgr = new SSHManager(srv.sshConfigPath);
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
// ssh2 ships both a CJS and ESM build; require() works reliably here since
// the test runner (vitest) handles the module boundary.
import ssh2pkg from "ssh2";

const { Server, utils: sshUtils } = ssh2pkg as typeof import("ssh2");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoopbackSshServer {
  /** Host (always 127.0.0.1) */
  host: string;
  /** OS-assigned TCP port the server is listening on */
  port: number;
  /** Username the server accepts (mirrors the current OS user) */
  user: string;
  /** Absolute path to the client private key file in PEM/OpenSSH format */
  clientKeyPath: string;
  /** Absolute path to the temp FLYWHEEL_HOME with ssh.yaml pre-written */
  flywheelHome: string;
  /** Absolute path to ssh.yaml — pass directly to new SSHManager(path) */
  sshConfigPath: string;
  /**
   * Extra directories prepended to PATH on the server side when executing
   * commands. Use to inject fake binaries (e.g. a fake `ntm` script).
   */
  extraPath: string[];
  /** Stop the server and delete all temp files */
  stop: () => Promise<void>;
}

export interface LoopbackSshOptions {
  /**
   * Extra directories to prepend to PATH when the server executes commands.
   * Useful for injecting a fake `ntm` script for NtmBridge tests.
   */
  extraPath?: string[];
  /**
   * When true, the server's command PATH is restricted to /usr/bin:/bin only
   * (extraPath still prepended). Use this to test "command not found" scenarios
   * without depending on what is installed on the host machine.
   */
  restrictPath?: boolean;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Start a loopback SSH server on a random port.
 * Returns a handle with connection details and a stop() teardown function.
 */
export async function startLoopbackSsh(
  opts: LoopbackSshOptions = {}
): Promise<LoopbackSshServer> {
  const extraPath = opts.extraPath ?? [];
  const baseSystemPath = opts.restrictPath
    ? "/usr/bin:/bin"
    : (process.env.PATH ?? "/usr/bin:/bin");

  // Create temp dir for key files and flywheel config
  const tmpBase = mkdtempSync(join(tmpdir(), "flywheel-ssh-test-"));
  mkdirSync(join(tmpBase, "keys"), { recursive: true });

  // Generate host key (server identity)
  const hostKeyPair = sshUtils.generateKeyPairSync("ed25519");
  const hostPrivateKey = hostKeyPair.private;

  // Generate client key pair (client authenticates with this)
  const clientKeyPair = sshUtils.generateKeyPairSync("ed25519");
  const clientPrivateKey = clientKeyPair.private;

  // Write client private key to disk — SSHManager reads it via privateKeyPath
  const clientKeyPath = join(tmpBase, "keys", "client_ed25519");
  writeFileSync(clientKeyPath, clientPrivateKey, { mode: 0o600 });

  // Current OS username (the server accepts connections from this user)
  const user = process.env.USER ?? process.env.LOGNAME ?? "ubuntu";

  // ── Start the ssh2.Server ──────────────────────────────────────────────────

  const server = new Server(
    { hostKeys: [hostPrivateKey] },
    (client) => {
      // Authentication: accept any publickey for our generated client key.
      // We trust the self-generated key pair without needing fingerprint
      // verification — this is explicitly for loopback testing.
      client.on("authentication", (ctx) => {
        if (ctx.method === "publickey") {
          // Accept without verifying the exact key — the generated pair is
          // self-consistent and no other client can connect to this ephemeral port.
          ctx.accept();
        } else if (ctx.method === "none") {
          ctx.reject(["publickey"]);
        } else {
          ctx.reject();
        }
      });

      client.on("ready", () => {
        client.on("session", (sessionAccept) => {
          const session = sessionAccept();

          session.on("exec", (execAccept, _execReject, info) => {
            const channel = execAccept();
            const command = info.command;

            // Build the PATH for the subprocess, injecting extraPath first
            const pathEnv =
              extraPath.length > 0
                ? `${extraPath.join(":")}:${baseSystemPath}`
                : baseSystemPath;

            const env = {
              ...process.env,
              HOME: homedir(),
              PATH: pathEnv,
            };

            // Run the command via sh -c in a real subprocess.
            // Collect stdout/stderr in buffers, then write everything to the
            // SSH channel after the process exits — this ensures channel.exit()
            // is called before channel.end(), which is what node-ssh expects
            // to properly receive the exit code.
            const child = nodeSpawn("sh", ["-c", command], { env });

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

            child.on("close", (code) => {
              const stdout = Buffer.concat(stdoutChunks);
              const stderr = Buffer.concat(stderrChunks);

              if (stdout.length > 0) {
                channel.write(stdout);
              }
              // channel.stderr is the SSH stderr sub-channel (ExtendedDataChannel)
              if (stderr.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (channel as any).stderr.write(stderr);
              }

              // exit() MUST be called before end() — it sends the SSH
              // exit-status channel request that node-ssh reads as response.code
              channel.exit(code ?? 0);
              channel.end();
            });

            child.on("error", (err) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (channel as any).stderr.write(`exec error: ${err.message}\n`);
              channel.exit(1);
              channel.end();
            });

            // If the client closes the channel before the process ends, kill it
            channel.on("close", () => {
              child.kill();
            });
          });

          // Reject PTY/shell requests — tests only need exec
          session.on("pty", (_accept, reject) => reject?.());
          session.on("shell", (_accept, reject) => reject?.());
        });
      });

      client.on("error", () => {
        // Swallow client-level errors to prevent unhandled rejection in tests
      });
    }
  );

  // ── Listen on a random loopback port ──────────────────────────────────────

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object" && "port" in addr) {
        resolve(addr.port as number);
      } else {
        reject(new Error("Could not determine loopback server port"));
      }
    });
    server.on("error", reject);
  });

  // ── Write flywheel config ──────────────────────────────────────────────────

  const sshConfig = {
    host: "127.0.0.1",
    user,
    port,
    key_path: clientKeyPath,
    remote_repo_root: "/tmp/flywheel-loopback-test",
  };

  const sshConfigPath = join(tmpBase, "ssh.yaml");
  writeFileSync(sshConfigPath, yaml.dump(sshConfig), "utf8");

  // FLYWHEEL_HOME convention: ssh.yaml lives directly in flywheelHome
  // SSHManager(configPath) accepts the path directly, bypassing FLYWHEEL_HOME.
  // But we expose flywheelHome for tests that need to set FLYWHEEL_HOME.
  const flywheelHome = tmpBase;

  // ── Return handle ──────────────────────────────────────────────────────────

  return {
    host: "127.0.0.1",
    port,
    user,
    clientKeyPath,
    flywheelHome,
    sshConfigPath,
    extraPath,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            rmSync(tmpBase, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
          resolve();
        });
      }),
  };
}

export interface FakeNtmBin {
  /** Absolute path to the directory containing the fake `ntm` binary */
  binDir: string;
  /** Delete the temp directory (call in afterEach or finally) */
  cleanup: () => void;
}

/**
 * Create a temp directory containing a fake `ntm` shell script.
 * The script outputs pre-defined JSON responses based on the subcommand,
 * matching the real ntm JSON output shapes that NtmBridge parses.
 *
 * Returns { binDir, cleanup } — pass binDir as an element of extraPath
 * to startLoopbackSsh(), and call cleanup() in afterEach or finally.
 */
export function createFakeNtmBin(opts?: {
  /** Override what `ntm list --json` returns */
  listJson?: object;
  /** Override what `ntm status <session> --json` returns */
  statusJson?: object;
}): FakeNtmBin {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-"));

  const listJson = opts?.listJson ?? {
    sessions: [
      {
        name: "test-session",
        windows: 1,
        pane_count: 2,
        attached: true,
        agents: { claude: 2, codex: 0, gemini: 0, user: 0, total: 2 },
      },
    ],
  };

  const statusJson = opts?.statusJson ?? {
    exists: true,
    session: "test-session",
    generated_at: new Date().toISOString(),
    panes: [
      { index: 0, title: "bead-1", type: "claude", active: true, command: "claude" },
      { index: 1, title: "bead-2", type: "claude", active: false, command: "claude" },
    ],
  };

  // Serialize the JSON objects once at harness-construction time.
  // The status JSON is output verbatim — NtmBridge.activity() does not use
  // the top-level "session" field from the response, so no SESSION substitution
  // is needed (and attempting it with shell quoting inside JSON is fragile).
  const listJsonStr = JSON.stringify(listJson);
  const statusJsonStr = JSON.stringify(statusJson);

  const ntmScript = `#!/bin/sh
# Fake ntm binary for integration testing
CMD="$1"
shift

case "$CMD" in
  list)
    echo '${listJsonStr}'
    ;;
  status)
    echo '${statusJsonStr}'
    ;;
  spawn)
    echo '{"ok":true,"pane_count":3}'
    ;;
  send)
    SESSION="$1"
    echo '{"success":true,"session":"'"$SESSION"'","delivered":1,"targets":[0]}'
    ;;
  interrupt)
    SESSION="$1"
    echo '{"ok":true,"session":"'"$SESSION"'"}'
    ;;
  *)
    echo '{"error":"unknown ntm subcommand: '"$CMD"'"}' >&2
    exit 1
    ;;
esac
`;

  const ntmPath = join(binDir, "ntm");
  writeFileSync(ntmPath, ntmScript, { mode: 0o755 });

  return {
    binDir,
    cleanup: () => {
      try {
        rmSync(binDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
