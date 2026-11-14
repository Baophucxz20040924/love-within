// Owned browser-verification Vite instance; does not change the normal developer proxy.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  root, configFile: `${root}/vite.config.ts`,
  server: { host: '127.0.0.1', port: 5175, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4002', changeOrigin: true } } },
});
await server.listen();
console.log('Realtime verification Vite listening at http://127.0.0.1:5175');
