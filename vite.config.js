import { defineConfig } from 'vite';

// GitHub Pages serves this from https://<user>.github.io/magnetic-lacquer/, so
// built asset URLs need that prefix or every script and texture 404s. It is
// applied to `build` only - the dev server stays at the root, where it is
// easier to type.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/magnetic-lacquer/' : '/',
}));
