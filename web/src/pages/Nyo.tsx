import { Chat } from '../components/Chat';

// Full-screen Nyo. Same component as the right-drawer Cmd/Ctrl+J pop-out — same
// localStorage conversation cache, same /api/chat SSE backend, same tool-use
// loop. Omitting `onClose` hides the X button (this is a page, not a drawer).
export function Nyo() {
  return (
    <div className="h-full bg-paper">
      <Chat />
    </div>
  );
}
