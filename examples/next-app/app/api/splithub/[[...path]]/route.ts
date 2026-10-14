import { createSplitHubHandler } from '@splithub/node';
import { sqliteStore } from '@splithub/adapter-sqlite';
import config from '../../../../splithub.config';

// Self-hosted ingest + results. Swap sqliteStore for your own Store
// (Postgres, Supabase, Prisma...) to keep events in your main database.
const handler = createSplitHubHandler({
  config,
  store: sqliteStore({ file: process.env.SPLITHUB_DB ?? './splithub.db' }),
  adminToken: process.env.SPLITHUB_ADMIN_TOKEN,
});

export const POST = handler;
export const GET = handler;
export const runtime = 'nodejs';
