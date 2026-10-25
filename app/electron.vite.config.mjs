import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// 主进程与 preload 单独打包：它们跑在 Node 环境，不能走浏览器构建链。
// 复用 node:sqlite / fs / path 这些内置模块，所以 target 必须是 node。
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false,
    target: 'node20',
    minify: false,          // 主进程报错时要能读到可读的栈
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      input: {
        main: 'electron/main.js',
        preload: 'electron/preload.js',
      },
      output: {
        format: 'cjs',
        // 必须是 .cjs：package.json 里 type=module，.js 会被当 ESM 解析，
        // 那样 require 就未定义了（实测报 app is undefined）
        entryFileNames: '[name].cjs',
      },
    },
  },
});