import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..");
const binDir = join(rootDir, "nil_gateway_gui", "src-tauri", "bin");
const resourceDir = join(rootDir, "nil_gateway_gui", "src-tauri");
const ext = process.platform === "win32" ? ".exe" : "";

mkdirSync(binDir, { recursive: true });

console.log("==> Building nil_gateway sidecar");
execFileSync(
  "go",
  ["build", "-o", join(binDir, `nil_gateway${ext}`), "."],
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
