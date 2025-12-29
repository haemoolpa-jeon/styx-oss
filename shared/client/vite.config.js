import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    lib: {
      entry: 'main.js',
      name: 'StyxModules',
      fileName: 'styx-modules',
      formats: ['iife']
    },
    sourcemap: true,
    minify: false,
    copyPublicDir: false
  },
  server: {
    port: 3001,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  }
});
