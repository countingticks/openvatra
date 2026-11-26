import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@app': resolve('src/app'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // `npm run perf` reads function names in the profiler's output; a minified bundle has none.
    ...(process.env.PERF_BUILD === '1' ? { build: { minify: false } } : {})
  }
})
