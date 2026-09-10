// Inline Lucide-shaped icons. Single source of truth.

type IconProps = { size?: number; className?: string };

function Svg({ children, size = 18, className = '' }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export const Plug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
  </Svg>
);

export const BookOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </Svg>
);

export const Activity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.5.5 0 0 1-.96 0L9.24 2.18a.5.5 0 0 0-.96 0L5.93 10.54A2 2 0 0 1 4 12H2" />
  </Svg>
);

export const Flame = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </Svg>
);

export const Network = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5"  cy="19" r="2.5" />
    <circle cx="19" cy="19" r="2.5" />
    <path d="M12 7v7" />
    <path d="M12 14l-5.5 3" />
    <path d="M12 14l5.5 3" />
  </Svg>
);

export const MessageSquare = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);

export const X = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const Menu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

export const Volume = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 4.7 6 9H2v6h4l5 4.3z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.8 5.5a9 9 0 0 1 0 13" />
  </Svg>
);

// Microphone — dictation (speech-to-text) toggle in the chat composer.
export const Mic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 17v4M8 21h8" />
  </Svg>
);

// Pencil — the edit affordance on publication rows and social post cards.
export const Pencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L4 16v4h4z" />
    <path d="m14 4.5 5.5 5.5" />
  </Svg>
);

export const Trash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Svg>
);

export const Globe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
  </Svg>
);

export const Target = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </Svg>
);

export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Svg>
);

export const Clock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const Wrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-7 7a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0 5.4-5.4l-3 3-2-2 2-2z" />
  </Svg>
);

export const Cube = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Svg>
);

export const Newspaper = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    <path d="M18 8h-4M18 12h-4M18 16h-4M6 8h4M6 12h4M6 16h4" />
  </Svg>
);

// LinkedIn glyph — filled "in" mark inside a rounded square. Used by the
// LinkedInText utility to collapse linkedin.com URLs in WA threads / drafts.
export const LinkedIn = (p: IconProps) => (
  <svg
    width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24"
    fill="currentColor" className={p.className || ''}
  >
    <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.21 0 22.23 0z" />
  </svg>
);

// ── Enrichment-step glyphs ──────────────────────────────────────────────────
// All monochrome on currentColor so the step strip can tint them by state
// (found / nothing found / not run) exactly like the dots they replaced.
// Brand marks are drawn as single-colour silhouettes for the same reason.

export const WhatsApp = (p: IconProps) => (
  <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="currentColor" className={p.className || ''}>
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01c-1.52 0-3.01-.41-4.31-1.18l-.31-.18-3.2.84.85-3.12-.2-.32a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.25 8.23z" />
    <path d="M17.47 14.38c-.29-.15-1.71-.84-1.98-.94-.27-.1-.46-.15-.65.15-.19.29-.75.94-.92 1.13-.17.19-.34.22-.63.07-.29-.15-1.22-.45-2.32-1.43-.86-.76-1.44-1.71-1.61-2-.17-.29-.02-.44.13-.59.13-.13.29-.34.44-.51.15-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.15-.65-1.57-.89-2.15-.23-.56-.47-.49-.65-.5h-.55c-.19 0-.51.07-.77.36-.27.29-1.01.99-1.01 2.41s1.04 2.8 1.18 2.99c.15.19 2.04 3.12 4.95 4.37.69.3 1.23.48 1.65.61.69.22 1.33.19 1.83.12.56-.08 1.71-.7 1.95-1.37.24-.68.24-1.26.17-1.38-.07-.12-.26-.19-.55-.34z" />
  </svg>
);

// Twilio mark — ring with the four dots. Single person = PDL (one identity
// resolved off a phone number).
export const Twilio = (p: IconProps) => (
  <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="currentColor" className={p.className || ''}>
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.6a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8z" />
    <circle cx="14.5" cy="9.5" r="1.85" />
    <circle cx="9.5"  cy="9.5" r="1.85" />
    <circle cx="14.5" cy="14.5" r="1.85" />
    <circle cx="9.5"  cy="14.5" r="1.85" />
  </svg>
);

export const User = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
  </Svg>
);

// Octopus — the SerpApi pass (many arms out across the open web at once).
export const Octopus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 13.5v-1.8a6 6 0 0 1 12 0v1.8" />
    <circle cx="9.9" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
    <circle cx="14.1" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
    <path d="M6 13.5c0 2-1 2.6-1.7 3.6M9.1 14.6c-.2 2.1-.8 2.9-1.3 3.9M12 14.9v3.9M14.9 14.6c.2 2.1.8 2.9 1.3 3.9M18 13.5c0 2 1 2.6 1.7 3.6" />
  </Svg>
);

export const CheckSquare = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="m8 12 2.8 2.8L16.5 9" />
  </Svg>
);

// Truecaller brand mark — white handset on the brand-blue rounded square. Same
// treatment as the LinkedIn glyph above: a real brand mark, used only to link
// out to that service. Ships its own colour, so it ignores currentColor.
export const Truecaller = (p: IconProps) => (
  <svg
    width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24"
    className={p.className || ''} aria-hidden
  >
    <rect width="24" height="24" rx="5.5" fill="#0099FF" />
    <g transform="translate(4.8 4.8) scale(0.6)">
      <path
        fill="#fff"
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"
      />
    </g>
  </svg>
);

export const Radio = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
  </Svg>
);

export const Sparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Svg>
);

export const Gear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

export const Sun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </Svg>
);

export const Coffee = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8h1a3 3 0 0 1 0 6h-1" />
    <path d="M3 8h15v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" />
    <path d="M6 2v3M10 2v3M14 2v3" />
  </Svg>
);

// Outbox / Send paper-plane glyph — used by the Outbox surface.
export const Send = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
  </Svg>
);

// Retry / refresh glyph for the retry button on failed Outbox rows.
export const Refresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
);

export const Moon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);

export const Monitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <path d="M8 21h8M12 17v4" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const Image = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L5 21" />
  </Svg>
);

export const BarChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <rect x="7"  y="13" width="3" height="6" />
    <rect x="12" y="9"  width="3" height="10" />
    <rect x="17" y="5"  width="3" height="14" />
  </Svg>
);

export const Calculator = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M8 6h8" />
    <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
  </Svg>
);

export const Users = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const Pin = (p: IconProps) => (
  <Svg {...p}>
    <line x1="12" x2="12" y1="17" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </Svg>
);

export const Star = (p: IconProps) => (
  <Svg {...p}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </Svg>
);

export const Calendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </Svg>
);

// Calendar with a check — the Daily Planner surface (plan the day + tick tasks).
export const CalendarCheck = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
    <path d="m9 16 2 2 4-4" />
  </Svg>
);

export const Funnel = (p: IconProps) => (
  <Svg {...p}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </Svg>
);

export const Workflow = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3"  y="3"  width="8" height="6" rx="1" />
    <rect x="13" y="9"  width="8" height="6" rx="1" />
    <rect x="3"  y="15" width="8" height="6" rx="1" />
    <path d="M7 9v3a1 1 0 0 0 1 1h5" />
    <path d="M17 15v1a2 2 0 0 1-2 2H8" />
  </Svg>
);
