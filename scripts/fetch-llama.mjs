// Downloads the llama.cpp build pinned in resources/llama/llama.json into resources/llama/bin/, which the app ships.
// Only the build (and CI) runs this, never the installed app. Standard library only; Windows' built-in tar unzips.
//
//   npm run fetch:llama
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const llamaDir = join(root, 'resources', 'llama')
const binDir = join(llamaDir, 'bin')
const tagFile = join(binDir, '.tag')
// Full path: Git for Windows puts GNU tar first on PATH, and that one can't read zips.
const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
const { tag, asset, sha256 } = JSON.parse(readFileSync(join(llamaDir, 'llama.json'), 'utf8'))

if (existsSync(tagFile) && readFileSync(tagFile, 'utf8').trim() === tag) {
  console.log(`llama.cpp ${tag} already in resources/llama/bin`)
  process.exit(0)
}

// One fixed host over HTTPS; fetch follows GitHub's redirect to its CDN.
const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset}`
console.log(`Downloading ${url}`)
const response = await fetch(url)
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
const zip = Buffer.from(await response.arrayBuffer())

// A build we can't verify is never unpacked, so a swapped or corrupted file can't end up in the installer.
const actual = createHash('sha256').update(zip).digest('hex')
if (actual !== sha256) throw new Error(`Checksum mismatch for ${asset}: expected ${sha256}, got ${actual}`)

rmSync(binDir, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })
const zipPath = join(llamaDir, asset)
writeFileSync(zipPath, zip)
try {
  const result = spawnSync(tar, ['-xf', zipPath, '-C', binDir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Could not extract the llama.cpp zip')
} finally {
  rmSync(zipPath, { force: true })
}
if (!existsSync(join(binDir, 'llama-server.exe'))) throw new Error('llama-server.exe missing from the zip')
// Written last: a half-finished run leaves no .tag, so the next run starts over.
writeFileSync(tagFile, tag)
console.log(`llama.cpp ${tag} ready in resources/llama/bin`)
