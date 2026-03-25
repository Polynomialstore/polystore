import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const gitignorePath = path.resolve(__dirname, '..', 'public', 'wasm', '.gitignore')

const contents = `*
!.gitignore
!nil_core.d.ts
!nil_core.js
!nil_core_bg.wasm
!nil_core_bg.wasm.d.ts
!package.json
`

await fs.writeFile(gitignorePath, contents, 'utf8')
