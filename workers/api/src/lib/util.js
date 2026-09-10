export function uid() {
  return crypto.randomUUID();
}
export function now() {
  return Date.now();
}
export function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}
