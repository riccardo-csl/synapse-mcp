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

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  denylist: string[],
  options: { signal?: AbortSignal } = {}
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
    const abortSignal = options.signal;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({
        command,
        code: null,
        stdout,
        stderr,
        timedOut: false,
        canceled: true
      });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      child.kill("SIGKILL");
      resolve({
        command,
        code: null,
        stdout,
        stderr,
        timedOut: true,
        canceled: false
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
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
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      clearTimeout(timer);
      resolve({
        command,
        code,
        stdout,
        stderr,
        timedOut: false,
        canceled: false
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
