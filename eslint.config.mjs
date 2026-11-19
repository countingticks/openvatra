import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintPluginJsxA11y from 'eslint-plugin-jsx-a11y'

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
  eslintConfigPrettier
)
