import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Arc UI 的块级组件内部 import "next/image"，本项目是 Vite。
// 用 alias 把它指到本地 shim，避免改动第三方组件源码。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'next/image': fileURLToPath(new URL('./src/shims/next-image.tsx', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
