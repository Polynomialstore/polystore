import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const checkOnly = process.argv.includes("--check");

const mappings = [
  ["whitepaper.md", path.join("polystore-website", "public", "whitepaper.md")],
  ["litepaper.md", path.join("polystore-website", "public", "litepaper.md")],
  ["spec.md", path.join("polystore-website", "public", "spec.md")],
];

let hasDiff = false;

for (const [sourceRel, targetRel] of mappings) {
  const sourcePath = path.join(repoRoot, sourceRel);
  const targetPath = path.join(repoRoot, targetRel);
  const source = fs.readFileSync(sourcePath, "utf8");
  const target = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;

  if (target === source) {
    console.log(`sync-papers: up to date ${targetRel}`);
    continue;
  }

  hasDiff = true;
  if (checkOnly) {
    console.error(`sync-papers: out of sync ${targetRel} <- ${sourceRel}`);
    continue;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, source, "utf8");
  console.log(`sync-papers: updated ${targetRel} from ${sourceRel}`);
}

if (checkOnly && hasDiff) {
  process.exit(1);
}
