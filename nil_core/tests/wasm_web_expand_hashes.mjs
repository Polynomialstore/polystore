// Computes SHA-256 digests of NilWasm.expand_file outputs for a fixed 8MiB fixture.
// Uses the *web-target* wasm-pack bundle that nil-website serves from `public/wasm`.
//
// Intended to be invoked from Rust tests (see expand_parity_test.rs).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixtureData() {
  const size = 8 * 1024 * 1024;
  const data = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    data[i] = (i * 31) & 0xff;
  }
  return data;
}

function sha256Hex(chunks) {
  const hasher = crypto.createHash("sha256");
  for (const chunk of chunks) {
    if (chunk == null) continue;
    if (Buffer.isBuffer(chunk)) {
      hasher.update(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      hasher.update(Buffer.from(chunk));
      continue;
    }
    if (Array.isArray(chunk)) {
      hasher.update(Buffer.from(chunk));
      continue;
    }
    throw new Error(`Unexpected chunk type: ${typeof chunk}`);
  }
  return hasher.digest("hex");
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");

  const trustedSetupPath = path.resolve(repoRoot, "demos/kzg/trusted_setup.txt");
  const trustedSetup = fs.readFileSync(trustedSetupPath);

  const wasmJsPath = path.resolve(repoRoot, "nil-website/public/wasm/nil_core.js");
  const wasmWasmPath = path.resolve(
    repoRoot,
    "nil-website/public/wasm/nil_core_bg.wasm",
  );
  const wasmBytes = fs.readFileSync(wasmWasmPath);

  const wasmModule = await import(pathToFileURL(wasmJsPath).toString());
  await wasmModule.default({ module_or_path: wasmBytes });

  const wasm = new wasmModule.NilWasm(trustedSetup);
  const expanded = wasm.expand_file(fixtureData());

  const witnessHex = sha256Hex(expanded.witness);
  const shardsHex = sha256Hex(expanded.shards);

  process.stdout.write(`${witnessHex}\n${shardsHex}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
