import path from 'node:path'
import { defineConfig } from 'vite'
import safeModulePathPlugin from './safeModulePathPlugin'
import svgVirtualModulePlugin from './svgVirtualModulePlugin'
import { getWindows83ShortNameForDotEnv } from './windows83Filename'

const BASE = '/base/'

export default defineConfig({
  base: BASE,
  build: {
    // separate outDir so that this build does not overwrite the output of
    // `vite.config.js` (both share the same root and run in parallel)
    outDir: 'dist/base',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/index.html'),
      },
    },
  },
  server: {
    fs: {
      strict: true,
      allow: [path.resolve(__dirname, 'src')],
    },
    hmr: {
      overlay: false,
    },
    headers: {
      'x-served-by': 'vite',
    },
  },
  preview: {
    headers: {
      'x-served-by': 'vite',
    },
  },
  define: {
    ROOT: JSON.stringify(path.dirname(__dirname).replace(/\\/g, '/')),
    BASE: JSON.stringify(BASE),
    DOTENV83SHORTNAME: JSON.stringify(getWindows83ShortNameForDotEnv()),
  },
  plugins: [svgVirtualModulePlugin(), safeModulePathPlugin()],
})
