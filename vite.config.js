import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const appBuildId = process.env.GITHUB_SHA || process.env.VITE_APP_BUILD_ID || `local-${Date.now()}`
const appBuiltAt = new Date().toISOString()

function appVersionManifest() {
  const source = JSON.stringify({ buildId: appBuildId, builtAt: appBuiltAt })
  return {
    name: 'tag-crm-version-manifest',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!String(request.url || '').split('?')[0].endsWith('/version.json')) return next()
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
        response.end(source)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), appVersionManifest()],
  base: '/tag-pipeline/',
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(appBuildId),
    'import.meta.env.VITE_APP_BUILT_AT': JSON.stringify(appBuiltAt),
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          msal: ['@azure/msal-browser', '@azure/msal-react'],
          router: ['react-router-dom'],
        },
      },
    },
  },
})
