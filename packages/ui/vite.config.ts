import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        styles: fileURLToPath(new URL('./src/styles.css', import.meta.url)),
        tokens: fileURLToPath(new URL('./src/tokens.css', import.meta.url)),
        primitives: fileURLToPath(new URL('./src/primitives.css', import.meta.url)),
        'design-system': fileURLToPath(new URL('./src/design-system.css', import.meta.url)),
      },
      output: {
        assetFileNames: '[name][extname]',
      },
    },
  },
});
