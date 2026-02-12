import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildCommit =
  process.env.VITE_GIT_COMMIT ??
  process.env.CF_PAGES_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  ''

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __NIL_BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
