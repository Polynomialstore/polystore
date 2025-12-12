// Computes SHA-256 digests of NilWasm.expand_file outputs for a fixed 8MiB fixture.
// Intended to be invoked from Rust tests (see expand_parity_test.rs).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { NilWasm } = require("../pkg/nil_core.js");

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

function main() {
  const trustedSetupPath = path.resolve(
    __dirname,
    "../../demos/kzg/trusted_setup.txt",
  );
  const trustedSetup = fs.readFileSync(trustedSetupPath);

  const wasm = new NilWasm(trustedSetup);
  const expanded = wasm.expand_file(fixtureData());

  const witnessHex = sha256Hex(expanded.witness);
  const shardsHex = sha256Hex(expanded.shards);

  process.stdout.write(`${witnessHex}\n${shardsHex}\n`);
}

main();

