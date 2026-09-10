import { callGateway } from '../../gateways/index.js';
import { logEvent } from '../../lib/db.js';

export const def = {
  name: 'read_page_headline',
  description: 'Fetch a public web page through the web gateway and return its <title> and status. Logs each read to the plugin log table.',
  input_schema: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL' } }, required: ['url'] },
};

export async function run(env, input) {
  const r = await callGateway(env, 'web', 'text', { url: input.url, max_bytes: 20000 });
  const m = String(r.text || '').match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = m ? m[1].trim() : null;
  await env.DB.prepare('INSERT INTO plugin_web_headline_log (id, url, title, at) VALUES (?, ?, ?, ?)')
    .bind(`hl_${Date.now()}`, input.url, title, Date.now()).run();
  await logEvent(env, { kind: 'plugin_headline_read', actor: 'tool', payload: { url: input.url, title } });
  return { url: input.url, status: r.status, title };
}
