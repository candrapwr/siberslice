import { spawn } from "node:child_process";

const MAX_OUTPUT = 40_000;

export function runPython(script, input, cwd, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("python3", ["-c", script], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Tidak bisa menjalankan Python: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectPromise(new Error(stderr.trim() || `Proses Python berakhir dengan kode ${code}.`));
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`Hasil proses Python tidak valid: ${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
