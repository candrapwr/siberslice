import { spawn } from "node:child_process";

const MAX_TOOL_OUTPUT = 40_000;

export async function executeShell({ command, workDir }) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Perintah shell kosong.");
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(shell, ["-c", command], { cwd: workDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 4_000).unref();
    }, 120_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Shell gagal dijalankan: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(JSON.stringify({ exitCode: code, timedOut, stdout, stderr }));
    });
  });
}
