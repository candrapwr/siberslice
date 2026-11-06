import { spawn } from "node:child_process";

const MAX_OUTPUT = 8_000_000;

export function runPython(script, input, cwd, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("python3", ["-c", script], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = "";
    let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      // Accumulate until the cap, then stop and fail loudly instead of
      // silently truncating JSON that later cannot be parsed.
      if (overflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) {
        overflow = true;
        stdoutChunks.length = 0;
        return;
      }
      stdoutChunks.push(chunk);
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
      if (overflow) return rejectPromise(new Error(`Output proses Python melebihi batas ${MAX_OUTPUT} byte.`));
      if (code !== 0) return rejectPromise(new Error(stderr.trim() || `Proses Python berakhir dengan kode ${code}.`));
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`Hasil proses Python tidak valid: ${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
