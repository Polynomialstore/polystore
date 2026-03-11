import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function readFaucetAuthTokenFromEtc() {
  const envPath = "/etc/nilstore/nil-faucet.env";
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("NIL_FAUCET_AUTH_TOKEN=")) continue;
      const value = trimmed.slice("NIL_FAUCET_AUTH_TOKEN=".length).trim();
      return value || "";
    }
  } catch {
    // Best-effort fallback only. Local dev should still work without /etc present.
  }
  return "";
}

function resolveViteBin() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const websiteRoot = path.resolve(scriptDir, "..");
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.resolve(websiteRoot, "node_modules", ".bin", `vite${suffix}`);
}

const args = process.argv.slice(2);

if (process.env.VITE_ENABLE_FAUCET == null || String(process.env.VITE_ENABLE_FAUCET).trim() === "") {
  process.env.VITE_ENABLE_FAUCET = "1";
}

if (!process.env.VITE_FAUCET_AUTH_TOKEN) {
  const token = readFaucetAuthTokenFromEtc();
  if (token) {
    process.env.VITE_FAUCET_AUTH_TOKEN = token;
    // Also export the non-Vite name for convenience in local scripts.
    if (!process.env.NIL_FAUCET_AUTH_TOKEN) process.env.NIL_FAUCET_AUTH_TOKEN = token;
  }
}

const viteBin = resolveViteBin();
const child = spawn(viteBin, args, { stdio: "inherit", env: process.env });
child.on("error", (err) => {
  console.error(`Failed to start Vite at ${viteBin}: ${err?.message || String(err)}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
