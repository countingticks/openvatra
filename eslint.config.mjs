import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintPluginJsxA11y from 'eslint-plugin-jsx-a11y'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
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
    files: ['src/renderer/src/components/ui/label.tsx'],
    rules: {
      'jsx-a11y/label-has-associated-control': 'off'
    }
  },
  {
    // shadcn/ui components export their style helpers (e.g. buttonVariants) next to the component.
    // Keeping upstream's file layout makes future shadcn updates easy to merge.
    files: ['src/renderer/src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off'
    }
  },
  eslintConfigPrettier
)
