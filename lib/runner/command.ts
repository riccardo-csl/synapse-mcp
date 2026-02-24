import { spawn } from "node:child_process";
import { synapseError } from "../synapse/errors.js";

export interface CommandResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
}

export interface RunShellOptions {
  signal?: AbortSignal;
  termGraceMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  denylist: string[],
  options: RunShellOptions = {}
): Promise<CommandResult> {
  for (const denied of denylist) {
    if (denied && command.includes(denied)) {
      throw synapseError("COMMAND_BLOCKED", "Command blocked by denylist", { command, denied });
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let canceled = false;
    const abortSignal = options.signal;
    const termGraceMs = typeof options.termGraceMs === "number" && options.termGraceMs >= 0
      ? options.termGraceMs
      : 1500;

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      canceled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // noop
      }

      if (termGraceMs === 0) {
        try {
          child.kill("SIGKILL");
        } catch {
          // noop
        }
        return;
      }

      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // noop
        }
      }, termGraceMs);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // noop
      }
      settle({
        command,
        code: null,
        stdout,
        stderr,
        timedOut: true,
        canceled: false
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      try {
        options.onStdoutChunk?.(text);
      } catch {
        // best-effort streaming callbacks must not affect command execution
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      try {
        options.onStderrChunk?.(text);
      } catch {
        // best-effort streaming callbacks must not affect command execution
      }
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(err);
    });

    child.on("close", (code) => {
      settle({
        command,
        code,
        stdout,
        stderr,
        timedOut: false,
        canceled
      });
    });
  });
}

export async function listChangedFiles(repoRoot: string): Promise<string[]> {
  const result = await runShellCommand("git status --porcelain", repoRoot, 20_000, []);
  if (result.code !== 0) {
    return [];
  }
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => line.slice(3).trim()).filter(Boolean);
}

export function tail(text: string, max = 4000): string {
  if (!text) {
    return "";
  }
  return text.length <= max ? text : text.slice(-max);
}
