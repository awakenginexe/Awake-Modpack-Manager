import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Relative base so the bundle can be loaded from a desktop shell's local file/asset origin.
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
