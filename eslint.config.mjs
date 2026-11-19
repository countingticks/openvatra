import fs from 'node:fs'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintPluginJsxA11y from 'eslint-plugin-jsx-a11y'

// A block banning imports by alias. Specifiers are matched as written; cross-folder imports are always `@app/…`.
// Uses the typescript-eslint rule for `allowTypeImports`. Each folder gets exactly one block so none overrides another.
function ban(group, message, allowTypeImports = false) {
  return { group, message, ...(allowTypeImports ? { allowTypeImports } : {}) }
}

// `@app` itself and the app root files; as a regex because a gitignore-style `@app` would match everything below it.
function banRoot(who) {
  return {
    regex: '^@app(/(App|createApp|index))?$',
    message: `${who} is below the app root: it may not import @app, App, createApp or index.`
  }
}

// Features are reached through their index.ts only, and only along these edges (SPEC-app decision 12).
const featureEdges = { settings: ['models'], chat: ['models'] }

// A new feature folder gets its block without editing this file.
const featureNames = fs
  .readdirSync(new URL('src/app/features', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

const banDeepFeature = ban(
  ['@app/features/*/**'],
  'Import a feature by its bare name (@app/features/<name>): its index.ts is the only entry.'
)

function layerBlock(files, banned) {
  return {
    files: [files],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns: banned }] }
  }
}

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'src/app/core/generated.ts'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // Accessibility checks for everything that renders UI.
    files: ['**/*.tsx'],
    ...eslintPluginJsxA11y.flatConfigs.recommended
  },
  {
    // Our <Label> (shadcn) is a <label>: check every use of it is tied to a control (htmlFor or a nested input).
    files: ['**/*.tsx'],
    rules: {
      'jsx-a11y/label-has-associated-control': ['error', { labelComponents: ['Label'], assert: 'either' }]
    }
  },
  {
    // The Label wrapper itself only passes props through; its uses are checked by the rule above.
    files: ['src/app/ui/label.tsx'],
    rules: {
      'jsx-a11y/label-has-associated-control': 'off'
    }
  },
  {
    // shadcn/ui components export their style helpers (e.g. buttonVariants) next to the component.
    // Keeping upstream's file layout makes future shadcn updates easy to merge.
    files: ['src/app/ui/[a-z]*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off'
    }
  },
  {
    // The host is reached through Platform, so the UI runs unchanged on another host and tests fake one object.
    files: [
      'src/app/**/*.{ts,tsx}',
      'src/shared/**/*.ts',
      'src/renderer/src/**/*.{ts,tsx}',
      'tests/unit/**/*.{ts,tsx}'
    ],
    ignores: ['src/renderer/src/main.tsx', 'src/renderer/src/desktopPlatform.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'api',
          message:
            'Use usePlatform() (or the platform passed to createAppStore); only main.tsx and desktopPlatform.ts read window.api.'
        }
      ]
    }
  },
  {
    // Rule 1: the UI never reaches Electron, and folders reach each other by alias, never by `../`.
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/app is host-independent: reach the host through Platform.' }
          ],
          patterns: [
            {
              group: ['electron/*'],
              message: 'src/app is host-independent: reach the host through Platform.'
            },
            {
              regex: '^\\.\\./',
              message: 'Import across folders by alias (@app/<folder>/…), never with ../.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'src/shared holds types and schemas used by both sides: no Electron.'
            },
            { name: '@app', message: 'src/shared is layer 0: it imports nothing from the UI.' }
          ],
          patterns: [
            {
              group: ['electron/*'],
              message: 'src/shared holds types and schemas used by both sides: no Electron.'
            },
            { group: ['@app/*'], message: 'src/shared is layer 0: it imports nothing from the UI.' },
            { regex: '^\\.\\./', message: 'Import across folders by alias, never with ../.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@app/*'], message: 'The host imports the UI only through the bare @app entry.' },
            { regex: '^\\.\\./', message: 'Import across folders by alias, never with ../.' }
          ]
        }
      ]
    }
  },
  // Layers: shared → lib/ui → platform/core/store → features → shell/app root → host (see SPEC-app).
  layerBlock('src/app/lib/**', [
    ban(
      ['@app/ui', '@app/platform', '@app/core', '@app/store', '@app/features', '@app/shell'],
      'lib is layer 1: it imports @shared only.'
    ),
    banRoot('lib')
  ]),
  layerBlock('src/app/ui/**', [
    ban(
      ['@app/platform', '@app/core', '@app/store', '@app/features', '@app/shell'],
      'ui is layer 1: it may import lib and @shared only.'
    ),
    banRoot('ui')
  ]),
  layerBlock('src/app/platform/**', [
    ban(
      ['@app/core', '@app/store', '@app/features', '@app/shell'],
      'platform is layer 2: it may import lib, ui and @shared only.'
    ),
    banRoot('platform')
  ]),
  layerBlock('src/app/core/**', [
    ban(['@app/store'], 'core may only `import type` from store.', true),
    ban(
      ['@app/features', '@app/shell'],
      'core is layer 2: it may import lib, ui, platform and @shared only.'
    ),
    banRoot('core')
  ]),
  layerBlock('src/app/store/**', [
    ban(
      ['@app/features', '@app/shell'],
      'store is layer 2: it may import lib, ui, platform, core and @shared only.'
    ),
    banRoot('store')
  ]),
  layerBlock('src/app/shell/**', [banRoot('shell'), banDeepFeature]),
  layerBlock('src/app/*.{ts,tsx}', [banDeepFeature]),
  ...featureNames.map((a) =>
    layerBlock(`src/app/features/${a}/**`, [
      ban(['@app/shell'], 'A feature may not import shell.'),
      banRoot('a feature'),
      banDeepFeature,
      ...featureNames
        .filter((b) => !featureEdges[a]?.includes(b))
        .map((b) =>
          ban(
            [`@app/features/${b}`],
            b === a
              ? `Import ${a}'s own files relatively, not through @app/features/${a}.`
              : `${a} may not import ${b}: the allowed feature edges are listed in eslint.config.mjs.`
          )
        )
    ])
  ),
  eslintConfigPrettier
)
