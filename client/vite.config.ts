import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const backend = `${process.env.BACKEND_HOST ?? 'localhost'}:${process.env.BACKEND_PORT ?? 3033}`

export default defineConfig({
  plugins: [vue()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://${backend}`,
        changeOrigin: true
      },
      '/ws': {
        target: `ws://${backend}`,
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
