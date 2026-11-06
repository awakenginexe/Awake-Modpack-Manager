import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Relative base so the bundle can be loaded from a desktop shell's local file/asset origin.
  base: './',
  build: { target: 'es2022' },
  // The Rust host rebuilds into src-tauri/target; watching it only produces busy-file errors.
  server: { watch: { ignored: ['**/src-tauri/**'] } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
