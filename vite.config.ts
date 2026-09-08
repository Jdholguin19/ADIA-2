import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { chatDevPlugin } from './vite-chat-plugin'

export default defineConfig(({ mode }) => {
  // Se cargan TODAS las variables (prefijo '') en process.env para que el
  // manejador del chat vea OPENAI_API_KEY en desarrollo. Solo las VITE_*
  // acaban en el bundle; la clave de OpenAI se queda en el proceso de node.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return {
  plugins: [
    react(),
    chatDevPlugin(),
    tailwindcss(),
    VitePWA({
      // 'prompt', not 'autoUpdate': silently swapping the app out from under
      // someone who is reading a dashboard is hostile.
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'ADIA — Analizador de Datos',
        short_name: 'ADIA',
        description: 'Analisis ejecutivo de datos con copiloto IA',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // SheetJS is a big chunk; let it load on demand rather than bloat precache.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Only plain REST GETs are cacheable. RPCs, auth and chat must never be:
            // a cached exec_analysis_sql response is exactly the stale-number
            // failure this whole design exists to prevent.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              url.pathname.startsWith('/rest/v1/') &&
              !url.pathname.startsWith('/rest/v1/rpc/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-rest',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 30 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  }
})
