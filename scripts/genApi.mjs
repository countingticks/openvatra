// Generates src/renderer/src/core/generated.ts (the RTK Query client) from core's OpenAPI document.
//
//   node scripts/genApi.mjs          ask core.exe for the document, write core/api/openapi.json and the client
//   node scripts/genApi.mjs --check  no Go: generate from the committed document and compare with the committed client
/* eslint-disable @typescript-eslint/explicit-function-return-type -- a plain JS script, there is no type syntax to put it in */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateEndpoints } from '@rtk-query/codegen-openapi'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const specFile = path.join(root, 'core/api/openapi.json')
const coreDir = path.join(root, 'src/renderer/src/core')
const outFile = path.join(coreDir, 'generated.ts')

const normalize = (text) => text.replaceAll('\r\n', '\n')

// Routes the renderer never calls through RTK Query: the OpenAI proxy, the chat streams (slice 5), shutdown (main),
// the folder opener (main) and the document itself.
const skipped = [
  'openaiModels',
  'openaiChatCompletions',
  'openaiEmbeddings',
  'sendMessage',
  'regenerate',
  'shutdown',
  'getCatalogFolder',
  'getOpenapi'
]

async function generateClient() {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
  // The codegen only types JSON responses; the stream's frames are JSON objects too (decision 10).
  const content = spec.paths['/api/events'].get.responses['200'].content
  content['application/json'] = content['text/event-stream']
  delete content['text/event-stream']

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openvatra-api-'))
  const cwd = process.cwd()
  try {
    const schemaFile = path.join(tmp, 'openapi.json')
    fs.writeFileSync(schemaFile, JSON.stringify(spec))
    // Without outputFile the codegen uses apiFile verbatim, so it must be relative to the working directory.
    process.chdir(coreDir)
    return await generateEndpoints({
      schemaFile,
      apiFile: './emptyApi.ts',
      apiImport: 'emptyApi',
      exportName: 'generatedApi',
      hooks: true,
      tag: true,
      prettierConfigFile: path.join(root, '.prettierrc.yaml'),
      filterEndpoints: (operationName) => !skipped.includes(operationName)
    })
  } finally {
    process.chdir(cwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv.includes('--check')) {
  const fresh = await generateClient()
  const committed = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (normalize(fresh) !== normalize(committed)) {
    console.log('src/renderer/src/core/generated.ts is stale: run npm run gen:api')
    process.exit(1)
  }
} else {
  let document
  try {
    document = execFileSync('go', ['run', '-C', 'core', '.', '--openapi'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    process.stderr.write(err.stderr?.toString() ?? String(err))
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(specFile), { recursive: true })
  fs.writeFileSync(specFile, document)
  fs.writeFileSync(outFile, await generateClient())
}
