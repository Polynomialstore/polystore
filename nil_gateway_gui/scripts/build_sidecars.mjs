import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..");
const binDir = join(rootDir, "nil_gateway_gui", "src-tauri", "bin");
const resourceDir = join(rootDir, "nil_gateway_gui", "src-tauri");
const ext = process.platform === "win32" ? ".exe" : "";
const nilCoreTarget =
  process.platform === "win32" ? "x86_64-pc-windows-gnu" : null;
const nilCoreReleaseDir = nilCoreTarget
  ? join(rootDir, "nil_core", "target", nilCoreTarget, "release")
  : join(rootDir, "nil_core", "target", "release");

let nilCoreArtifacts;
if (process.platform === "win32") {
  nilCoreArtifacts = ["nil_core.dll", "libnil_core.dll"];
} else if (process.platform === "darwin") {
  nilCoreArtifacts = ["libnil_core.dylib"];
} else {
  nilCoreArtifacts = ["libnil_core.so"];
}

mkdirSync(binDir, { recursive: true });

console.log("==> Building nil_core shared library");
const cargoArgs = ["build", "--release"];
if (nilCoreTarget) {
  cargoArgs.push("--target", nilCoreTarget);
}
execFileSync("cargo", cargoArgs, {
  cwd: join(rootDir, "nil_core"),
  stdio: "inherit",
});

const nilCorePath = nilCoreArtifacts
  .map((name) => join(nilCoreReleaseDir, name))
  .find((candidate) => existsSync(candidate));

if (!nilCorePath) {
  throw new Error(
    `nil_core shared library not found in ${nilCoreReleaseDir} (expected one of: ${nilCoreArtifacts.join(", ")})`,
  );
}

console.log(`==> Staging ${basename(nilCorePath)}`);
copyFileSync(nilCorePath, join(binDir, basename(nilCorePath)));

console.log("==> Building nil_gateway sidecar");
const nilGatewayOutput = join(binDir, `nil_gateway${ext}`);
if (existsSync(nilGatewayOutput)) {
  unlinkSync(nilGatewayOutput);
}
execFileSync(
  "go",
  ["build", "-o", nilGatewayOutput, "."],
  {
    cwd: join(rootDir, "nil_gateway"),
    stdio: "inherit",
  },
);

console.log("==> Building nil_cli sidecar");
execFileSync("cargo", ["build", "--release"], {
  cwd: join(rootDir, "nil_cli"),
  stdio: "inherit",
});
copyFileSync(
  join(rootDir, "nil_cli", "target", "release", `nil_cli${ext}`),
  join(binDir, `nil_cli${ext}`),
);

console.log("==> Copying trusted setup");
copyFileSync(
  join(rootDir, "nilchain", "trusted_setup.txt"),
  join(resourceDir, "trusted_setup.txt"),
);

console.log(`Sidecars staged in ${binDir}`);
