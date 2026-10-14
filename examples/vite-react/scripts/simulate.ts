/**
 * Sends synthetic traffic through the real SDK to the running dev server so
 * `splithub results hero-cta` has something to show.
 *
 *   pnpm dev            (in another terminal)
 *   pnpm simulate
 */
import { createClient, createFetchTransport } from '@splithub/core';
import config from '../splithub.config.ts';

const endpoint = process.env.SPLITHUB_URL ?? 'http://localhost:5173/api/splithub';
const visitors = Number(process.env.VISITORS ?? 3000);
const transport = createFetchTransport({ endpoint });

const rates: Record<string, number> = { control: 0.08, bold: 0.12 };
let sent = 0;

for (let i = 0; i < visitors; i++) {
  const client = createClient(config, { visitorId: `sim_${Date.now()}_${i}`, sessionId: `s_${i}`, transport });
  const variant = client.variant('hero-cta');
  client.value('hero-title');
  if (Math.random() < (rates[variant] ?? 0.1)) client.track('signup');
  await client.flush();
  sent++;
  if (sent % 100 === 0) console.log(`sent ${sent}/${visitors}`);
}
console.log(`done: ${sent} visitors → ${endpoint}`);
