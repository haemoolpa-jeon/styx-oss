import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: '.',
    emptyOutDir: false,
    lib: {
      entry: 'main.js',
      name: 'StyxModules',
      fileName: () => 'styx-modules.js',
      formats: ['iife']
    },
    sourcemap: false,
    minify: true
  }
});
