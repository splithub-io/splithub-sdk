import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { createSplitHubHandler, toNodeListener } from '@splithub/node';
import { sqliteStore } from '@splithub/adapter-sqlite';
import { splithub } from '@splithub/core/vite';
import config from './splithub.config';

/**
 * Self-hosted mode in one file: the ingest/results handler runs inside the
 * Vite dev server and writes to ./splithub.db. In production you would mount
 * the same handler in your API (Next route, Express, Hono...).
 */
function splithubDevServer(): Plugin {
  return {
    name: 'splithub-dev-server',
    configureServer(server) {
      const store = sqliteStore({ file: './splithub.db' });
      server.middlewares.use('/api/splithub', toNodeListener(createSplitHubHandler({ config, store })));
    },
  };
}

export default defineConfig({
  // splithub(): what each experiment does in development, printed in this terminal.
  plugins: [react(), splithubDevServer(), splithub()],
  server: { port: 5173 },
});
