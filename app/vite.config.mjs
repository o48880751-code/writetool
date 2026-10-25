import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 渲染进程用标准 Vite；Electron 主进程单独打包（见 electron.vite.config.mjs）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Electron 走 file:// 加载打包产物，资源必须用相对路径
  base: './',
  resolve: {
    alias: {
      // 渲染进程要复用 editor/ 下的流式写入逻辑（纯 JS，无 DOM 依赖）。
      // 用别名而不是相对路径 import：Vite 不允许 import 上级目录（逃出 root），
      // 而 editor/ 是测试与前端共用的模块，不该复制一份到 app/ 里——
      // 复制过一次，测试与实现的版本就漂移了。
      '@editor': path.resolve(process.cwd(), '../editor'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 主进程与 preload 是 CJS，不能被 vite 处理
    rollupOptions: { external: ['electron'] },
  },
  server: { port: 5183, strictPort: true },
});