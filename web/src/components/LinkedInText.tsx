// LinkedInText — renders body text where every linkedin.com URL becomes a
// compact icon chip instead of a noisy raw URL. Used in WhatsApp thread
// snippets, digest summaries, and reply drafts so a sentence like
// "check out https://www.linkedin.com/in/lev-kerzhner-..." reads cleanly.

import React from 'react';
import { LinkedIn } from './Icons';

const LINKEDIN_RE = /(https?:\/\/(?:www\.)?linkedin\.com\/[^\s)>\]]+)/gi;

function labelFor(url: string): string {
  const m = url.match(/linkedin\.com\/(?:in|company|pub|profile|school)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : 'LinkedIn';
}

export function LinkedInText({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  LINKEDIN_RE.lastIndex = 0;
  while ((m = LINKEDIN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[0];
    const label = labelFor(url);
    parts.push(
      <a
        key={m.index}
        href={url}
        target="_blank"
        rel="noreferrer"
        title={label + ' · ' + url}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center align-middle mx-0.5 px-1 h-5 rounded-sm bg-[#0a66c2]/10 hover:bg-[#0a66c2]/20 text-[#0a66c2] transition"
        style={{ verticalAlign: 'middle' }}
      >
        <LinkedIn size={11} />
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (parts.length === 0) return <>{text}</>;
  return <span className={className}>{parts}</span>;
}
