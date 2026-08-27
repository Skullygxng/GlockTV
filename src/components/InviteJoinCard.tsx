import { Copy, Share2 } from 'lucide-react';

interface InviteJoinCardProps {
  code: string;
  titleName: string;
  copied: boolean;
  onCopy: () => void;
  onShare: () => void;
}

export function InviteJoinCard({ code, titleName, copied, onCopy, onShare }: InviteJoinCardProps) {
  return (
    <section className="invite-join-card" aria-label="Pinned room invite">
      <div>
        <small>Room invite</small>
        <strong>{code}</strong>
        <span>Share {titleName} with this room code</span>
      </div>
      <div className="invite-join-card__actions">
        <button type="button" aria-label="Copy invite" onClick={onCopy}>
          <Copy /> {copied ? 'Copied' : 'Copy invite'}
        </button>
        <button type="button" aria-label="Share invite" onClick={onShare}>
          <Share2 /> Share invite
        </button>
      </div>
    </section>
  );
}
