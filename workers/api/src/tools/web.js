// web — Nyo's page-fetch tool (restored: it was cut with the Website module
// in slim phase 1, but reading pages is a core Nyo capability — the voice
// interview reads the operator's site with it).

import { fetchArticleText } from '../lib/heartbeat.js';
import { fetchText as webGatewayFetchText } from '../lib/web-gateway.js';

export const tools = {
  web_fetch: {
    def: {
      name: 'web_fetch',
      description: 'Fetch a public web page or JSON/text endpoint over http(s) and return its readable text (HTML stripped, prefers the article/main body, capped). Use to read an article, check a live page, or pull a public API before answering. Returns {url, status, truncated, content}.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to fetch.' },
          max_chars: { type: 'number', description: 'Cap on returned text (default 12000, max 40000).' },
        },
        required: ['url'],
      },
    },
    run: async (env, input) => {
      const url = String(input.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
      const cap = Math.min(40000, Math.max(500, Number(input.max_chars) || 12000));
      let content = await fetchArticleText(env, url, { maxChars: cap });
      let status = 200;
      if (!content) {
        const r = await webGatewayFetchText(env, { url, max_bytes: cap * 4 });
        status = r.status;
        content = String(r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
      }
      return { url, status, truncated: content.length >= cap, content };
    },
  },
};
