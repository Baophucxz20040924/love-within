import { shortName } from '../../lib/format';
import type { JoinResult } from '../../lib/types';

interface ToastLike {
  success: (m: string) => void;
  info: (m: string) => void;
}

/** Tell the user what an invite link did after joining the friends space. */
export function announceInvite(result: JoinResult | null | undefined, toast: ToastLike): void {
  const invite = result?.invite;
  if (!invite) return;
  const name = invite.inviter ? shortName(invite.inviter.displayName) : '';
  switch (invite.status) {
    case 'friended':
      toast.success(`Bạn và ${name} đã là bạn bè`);
      break;
    case 'already_friends':
      toast.info(`Bạn và ${name} đã là bạn bè từ trước`);
      break;
    case 'self':
      toast.info('Đây là link mời của chính bạn');
      break;
    default:
      toast.info('Link mời không còn hiệu lực, nhưng bạn vẫn vào được Hội bạn bè.');
  }
}
