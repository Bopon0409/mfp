import { defineConfig } from 'vite';
import { devFiles } from '../../tools/dev-files.ts';

export default defineConfig({
  plugins: [devFiles()],
  server: { port: 5173 },
});
