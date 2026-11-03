// Claude Code hook: after the agent edits or writes a file, format it with Prettier so no separate format step
// is needed. Gets the tool call as JSON on stdin; files outside this project and file types Prettier doesn't
// know are skipped. It never blocks the edit: a formatting failure only prints a note.
import { spawnSync } from 'node:child_process'
import { relative, isAbsolute } from 'node:path'

let input = ''
for await (const chunk of process.stdin) input += chunk

const filePath = JSON.parse(input).tool_input?.file_path
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const inside =
  filePath && !relative(projectDir, filePath).startsWith('..') && !isAbsolute(relative(projectDir, filePath))

if (inside) {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/prettier/bin/prettier.cjs',
      '--write',
      '--ignore-unknown',
      '--log-level',
      'warn',
      filePath
    ],
    { cwd: projectDir, encoding: 'utf8' }
  )
  if (result.status !== 0)
    console.error(`prettier: ${(result.stderr || result.stdout).trim().split('\n')[0]}`)
}
