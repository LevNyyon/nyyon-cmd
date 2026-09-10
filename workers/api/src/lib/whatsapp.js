// WhatsApp — what remains after the daemon and the sender extension died.
// The D1 store (wa_messages / wa_chats / wa_lid_map) is the historical
// record; outbound WhatsApp is the operator clicking a wa.me link. The send
// functions below THROW so every leftover caller (old outbox retries, digest
// actions) fails loudly into Activity instead of pretending to deliver.

export function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('chatId required');
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`could not parse chatId from ${input}`);
  // Local Israeli format → international. A bare leading-0 number produces an
  // invalid wid ('0504...@c.us') that WhatsApp Web CRASHES ON AT BOOT when it
  // arrives via a /send link — the sender extension's blank-screen wedge.
  // (E.164 numbers never start with 0, so this is safe for the rest.)
  const intl = digits.startsWith('0') ? '972' + digits.slice(1) : digits;
  return `${intl}@c.us`;
}

const SEND_REMOVED = 'WhatsApp machine-sending was removed — open the wa.me link and send it yourself.';
export async function sendText() { throw new Error(SEND_REMOVED); }
export async function replyToWaMessage() { throw new Error(SEND_REMOVED); }
export async function sendImage() { throw new Error(SEND_REMOVED); }
export async function sendDocument() { throw new Error(SEND_REMOVED); }
export async function reactToMessage() { throw new Error(SEND_REMOVED); }
