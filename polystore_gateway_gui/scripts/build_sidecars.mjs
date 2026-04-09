import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..");
const binDir = join(rootDir, "polystore_gateway_gui", "src-tauri", "bin");
const ext = process.platform === "win32" ? ".exe" : "";
const polystoreCoreTarget =
  process.platform === "win32" ? "x86_64-pc-windows-gnu" : null;
const polystoreCoreReleaseDir = polystoreCoreTarget
  ? join(rootDir, "polystore_core", "target", polystoreCoreTarget, "release")
  : join(rootDir, "polystore_core", "target", "release");

let polystoreCoreArtifacts;
if (process.platform === "win32") {
  polystoreCoreArtifacts = ["polystore_core.dll", "libpolystore_core.dll"];
} else if (process.platform === "darwin") {
  polystoreCoreArtifacts = ["libpolystore_core.dylib"];
} else {
  polystoreCoreArtifacts = ["libpolystore_core.so"];
}

mkdirSync(binDir, { recursive: true });

function atomicCopy(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

console.log("==> Building polystore_core shared library");
const cargoArgs = ["build", "--release"];
if (polystoreCoreTarget) {
  cargoArgs.push("--target", polystoreCoreTarget);
}
execFileSync("cargo", cargoArgs, {
  cwd: join(rootDir, "polystore_core"),
  stdio: "inherit",
});

const polystoreCorePath = polystoreCoreArtifacts
  .map((name) => join(polystoreCoreReleaseDir, name))
  .find((candidate) => existsSync(candidate));

if (!polystoreCorePath) {
  throw new Error(
    `polystore_core shared library not found in ${polystoreCoreReleaseDir} (expected one of: ${polystoreCoreArtifacts.join(", ")})`,
  );
}

console.log(`==> Staging ${basename(polystoreCorePath)}`);
atomicCopy(polystoreCorePath, join(binDir, basename(polystoreCorePath)));

console.log("==> Building polystore_gateway sidecar");
const polystoreGatewayOutput = join(binDir, `polystore_gateway${ext}`);
const polystoreGatewayTempOutput = `${polystoreGatewayOutput}.tmp-${process.pid}-${Date.now()}`;
const goBuildArgs = ["build"];
if (process.platform === "linux") {
  goBuildArgs.push("-ldflags", "-extldflags=-Wl,-rpath,$ORIGIN");
} else if (process.platform === "darwin") {
  goBuildArgs.push("-ldflags", "-extldflags=-Wl,-rpath,@loader_path");
}
goBuildArgs.push("-o", polystoreGatewayTempOutput, ".");
execFileSync(
  "go",
  goBuildArgs,
  {
    cwd: join(rootDir, "polystore_gateway"),
    stdio: "inherit",
  },
);
renameSync(polystoreGatewayTempOutput, polystoreGatewayOutput);

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
