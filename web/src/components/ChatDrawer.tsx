import { useEffect } from 'react';
import { Chat } from './Chat';

type Props = { open: boolean; onClose: () => void };

export function ChatDrawer({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        className={
          'lg:hidden fixed inset-0 bg-black/25 backdrop-blur-[1px] z-40 transition-opacity duration-200 ' +
          (open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none')
        }
      />
      <aside
        aria-hidden={!open}
        className={
          'fixed top-0 right-0 h-full w-full sm:w-[460px] bg-paper border-l border-line z-50 ' +
          'shadow-[-16px_0_40px_-20px_rgba(10,10,10,0.18)] ' +
          'transition-transform duration-300 ease-out ' +
          (open ? 'translate-x-0' : 'translate-x-full')
        }
      >
        <Chat onClose={onClose} />
      </aside>
    </>
  );
}
