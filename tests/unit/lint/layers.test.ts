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

beforeAll(() => {
  eslint = new ESLint({ cwd: root })
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
  ['window.api in src/shared', 'src/shared/fake.ts', readsApi, true]
]

describe('lint: host and folder edges', () => {
  it.each(cases)('%s', async (_name, file, code, fails) => {
    const found = await lint(file, code)
    if (fails) expect(found.length).toBeGreaterThan(0)
    else expect(found).toEqual([])
  })
})
