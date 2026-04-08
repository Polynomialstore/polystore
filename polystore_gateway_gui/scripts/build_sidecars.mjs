import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..");
const binDir = join(rootDir, "polystore_gateway_gui", "src-tauri", "bin");
const ext = process.platform === "win32" ? ".exe" : "";
const nilCoreTarget =
  process.platform === "win32" ? "x86_64-pc-windows-gnu" : null;
const nilCoreReleaseDir = nilCoreTarget
  ? join(rootDir, "polystore_core", "target", nilCoreTarget, "release")
  : join(rootDir, "polystore_core", "target", "release");

let nilCoreArtifacts;
if (process.platform === "win32") {
  nilCoreArtifacts = ["polystore_core.dll", "libpolystore_core.dll"];
} else if (process.platform === "darwin") {
  nilCoreArtifacts = ["libpolystore_core.dylib"];
} else {
  nilCoreArtifacts = ["libpolystore_core.so"];
}

mkdirSync(binDir, { recursive: true });

function atomicCopy(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

console.log("==> Building polystore_core shared library");
const cargoArgs = ["build", "--release"];
if (nilCoreTarget) {
  cargoArgs.push("--target", nilCoreTarget);
}
execFileSync("cargo", cargoArgs, {
  cwd: join(rootDir, "polystore_core"),
  stdio: "inherit",
});

const nilCorePath = nilCoreArtifacts
  .map((name) => join(nilCoreReleaseDir, name))
  .find((candidate) => existsSync(candidate));

if (!nilCorePath) {
  throw new Error(
    `polystore_core shared library not found in ${nilCoreReleaseDir} (expected one of: ${nilCoreArtifacts.join(", ")})`,
  );
}

console.log(`==> Staging ${basename(nilCorePath)}`);
atomicCopy(nilCorePath, join(binDir, basename(nilCorePath)));

console.log("==> Building polystore_gateway sidecar");
const nilGatewayOutput = join(binDir, `polystore_gateway${ext}`);
const nilGatewayTempOutput = `${nilGatewayOutput}.tmp-${process.pid}-${Date.now()}`;
const goBuildArgs = ["build"];
if (process.platform === "linux") {
  goBuildArgs.push("-ldflags", "-extldflags=-Wl,-rpath,$ORIGIN");
} else if (process.platform === "darwin") {
  goBuildArgs.push("-ldflags", "-extldflags=-Wl,-rpath,@loader_path");
}
goBuildArgs.push("-o", nilGatewayTempOutput, ".");
execFileSync(
  "go",
  goBuildArgs,
  {
    cwd: join(rootDir, "polystore_gateway"),
    stdio: "inherit",
  },
);
renameSync(nilGatewayTempOutput, nilGatewayOutput);

console.log("==> Building polystore_cli sidecar");
execFileSync("cargo", ["build", "--release"], {
  cwd: join(rootDir, "polystore_cli"),
  stdio: "inherit",
});
atomicCopy(
  join(rootDir, "polystore_cli", "target", "release", `polystore_cli${ext}`),
  join(binDir, `polystore_cli${ext}`),
);

console.log("==> Copying trusted setup");
copyFileSync(
  join(rootDir, "polystorechain", "trusted_setup.txt"),
  join(binDir, "trusted_setup.txt"),
);

console.log(`Sidecars staged in ${binDir}`);
