import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function readPublicTestnetEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(scriptDir, "..", "..", ".env.testnet.public");
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function readFaucetAuthTokenFromEtc() {
  const envPath = "/etc/polystore/polystore-faucet.env";
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
const publicTestnetEnv = readPublicTestnetEnv();
const faucetBase =
  publicTestnetEnv.POLYSTORE_TESTNET_FAUCET_URL?.replace(/\/faucet\/?$/, "") || "";
// E2E harnesses stub loopback services and should not inherit public testnet endpoints.
const isE2E = process.env.VITE_E2E === "1";

if (!isE2E && !process.env.VITE_API_BASE && faucetBase) {
  process.env.VITE_API_BASE = faucetBase;
}
if (!isE2E && !process.env.VITE_LCD_BASE && publicTestnetEnv.POLYSTORE_TESTNET_LCD_BASE) {
  process.env.VITE_LCD_BASE = publicTestnetEnv.POLYSTORE_TESTNET_LCD_BASE;
}
if (!isE2E && !process.env.VITE_EVM_RPC && publicTestnetEnv.POLYSTORE_TESTNET_EVM_RPC) {
  process.env.VITE_EVM_RPC = publicTestnetEnv.POLYSTORE_TESTNET_EVM_RPC;
}
if (!isE2E && !process.env.VITE_COSMOS_CHAIN_ID && publicTestnetEnv.POLYSTORE_TESTNET_CHAIN_ID) {
  process.env.VITE_COSMOS_CHAIN_ID = publicTestnetEnv.POLYSTORE_TESTNET_CHAIN_ID;
}
if (!isE2E && !process.env.VITE_CHAIN_ID && publicTestnetEnv.POLYSTORE_TESTNET_CHAIN_ID) {
  process.env.VITE_CHAIN_ID = publicTestnetEnv.POLYSTORE_TESTNET_CHAIN_ID;
}

if (process.env.VITE_ENABLE_FAUCET == null || String(process.env.VITE_ENABLE_FAUCET).trim() === "") {
  process.env.VITE_ENABLE_FAUCET = "1";
}

if (!process.env.VITE_FAUCET_AUTH_TOKEN) {
  const token =
    publicTestnetEnv.POLYSTORE_TESTNET_FAUCET_AUTH_TOKEN ||
    readFaucetAuthTokenFromEtc();
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
