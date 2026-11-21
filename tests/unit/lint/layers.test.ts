// @vitest-environment node
import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const rules = new Set([
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-properties'
])

let eslint: ESLint

beforeAll(async () => {
  eslint = new ESLint({ cwd: root })
  // The first lint builds the TypeScript program for typed rules, which takes seconds under a full run: do it here,
  // in the hook's budget, not in the first case's.
  await eslint.lintText('export {}\n', { filePath: path.join(root, 'src/app/lib/warmup.ts') })
}, 30_000)

async function lint(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) })
  return result.messages.flatMap((m) => (m.ruleId && rules.has(m.ruleId) ? [m.ruleId] : []))
}

const imp = (spec: string, type = false): string =>
  `import ${type ? 'type ' : ''}{ x } from '${spec}'\nexport const y = x`
const readsApi = 'export const y = window.api'

// [description, file, code, fails]
const cases: Array<[string, string, string, boolean]> = [
  ['../ out of a folder', 'src/app/ui/Fake.tsx', imp('../store/hooks'), true],
  ['./ inside a folder', 'src/app/core/Fake.ts', imp('./sse'), false],
  ['electron in src/app', 'src/app/ui/Fake.tsx', imp('electron'), true],
  ['@app from src/shared', 'src/shared/fake.ts', imp('@app'), true],
  ['deep @app from the host', 'src/renderer/src/fake.ts', imp('@app/core/coreApi'), true],
  ['bare @app from the host', 'src/renderer/src/fake.ts', imp('@app'), false],
  ['@shared from the host', 'src/renderer/src/fake.ts', imp('@shared/settings'), false],
  ['window.api in src/app', 'src/app/core/Fake.ts', readsApi, true],
  ['window.api in src/shared', 'src/shared/fake.ts', readsApi, true],
  ['ui imports store', 'src/app/ui/Fake.tsx', imp('@app/store/hooks'), true],
  ['ui imports lib', 'src/app/ui/Fake.tsx', imp('@app/lib/utils'), false],
  ['lib imports ui', 'src/app/lib/fake.ts', imp('@app/ui/button'), true],
  ['platform imports core', 'src/app/platform/Fake.ts', imp('@app/core/coreApi'), true],
  ['core imports a store type', 'src/app/core/Fake.ts', imp('@app/store/store', true), false],
  ['core imports a store value', 'src/app/core/Fake.ts', imp('@app/store/store'), true],
  ['store imports a feature', 'src/app/store/Fake.ts', imp('@app/features/models'), true],
  ['shell imports the app root', 'src/app/shell/Fake.tsx', imp('@app/App'), true],
  [
    'feature imports a deep path',
    'src/app/features/settings/Fake.ts',
    imp('@app/features/models/useModels'),
    true
  ],
  ['feature imports along an edge', 'src/app/features/settings/Fake.ts', imp('@app/features/models'), false],
  ['models imports settings', 'src/app/features/models/Fake.ts', imp('@app/features/settings'), true],
  ['chat imports models', 'src/app/features/chat/Fake.tsx', imp('@app/features/models'), false],
  ['code imports models', 'src/app/features/code/Fake.tsx', imp('@app/features/models'), true],
  [
    'shell imports a deep feature path',
    'src/app/shell/Fake.tsx',
    imp('@app/features/models/ModelsDialog'),
    true
  ],
  ['shell imports a feature', 'src/app/shell/Fake.tsx', imp('@app/features/models'), false]
]

describe('lint: host and folder edges', () => {
  it.each(cases)('%s', async (_name, file, code, fails) => {
    const found = await lint(file, code)
    if (fails) expect(found.length).toBeGreaterThan(0)
    else expect(found).toEqual([])
  })
})
