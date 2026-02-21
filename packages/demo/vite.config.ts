import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@proofoflove/chain-adapters': path.resolve(__dirname, '../chain-adapters/src/index.ts'),
      '@proofoflove/core': path.resolve(__dirname, '../core/src/index.ts'),
      buffer: 'buffer/',
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['snarkjs', 'circomlibjs', 'buffer'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});