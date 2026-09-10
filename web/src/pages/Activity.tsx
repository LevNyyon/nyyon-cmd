import { useEffect, useState } from 'react';
import { api, Event } from '../lib/api';

export function Activity() {
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    const load = () => api.events(100).then(setEvents).catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="rounded-sm hairline bg-card/80 overflow-x-auto">
        <div className="px-4 h-9 border-b border-line flex items-center mono text-[10px] uppercase tracking-[0.18em] text-mute">
          Activity log · live
        </div>
        {events.length === 0 ? (
          <div className="p-4 text-mute text-sm">No activity yet.</div>
        ) : (
          <ul className="divide-y divide-line min-w-[720px]">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 grid grid-cols-12 gap-3 items-baseline">
                <span className="col-span-3 mono text-[10px] text-mute">{new Date(e.created_at).toLocaleString()}</span>
                <span className="col-span-2 mono text-[11px] uppercase tracking-wider">{e.kind}</span>
                <span className="col-span-2 mono text-[10px] text-mute">{e.actor}</span>
                <pre className="col-span-5 mono text-[10px] text-mute whitespace-pre-wrap break-all line-clamp-2">{e.payload ? JSON.stringify(e.payload) : ''}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
