import { useAuth } from '../auth/AuthContext';
import { localDateOf, shortName } from '../../lib/format';
import type { DailyQuestion } from '../../lib/types';

/** Me, my partner (short name for sentences) and today's date in the couple timezone. */
export function useCouplePeople() {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id) ?? null;
  const timezone = me?.couple?.timezone ?? me?.user.timezone ?? 'Asia/Ho_Chi_Minh';
  return {
    myId: me?.user.id ?? '',
    myName: me?.user.displayName ?? '',
    partnerId: partner?.id ?? null,
    partnerFullName: partner?.displayName ?? 'Người ấy',
    partnerName: partner ? shortName(partner.displayName) : 'Người ấy',
    today: localDateOf(new Date(), timezone),
  };
}

/** "Câu hỏi của Hà" / "Câu hỏi bạn gửi" for our own questions, else the bank category. */
export function questionLabel(q: DailyQuestion, myId: string, partnerName: string): string | null {
  if (q.source === 'partner') return q.askedBy === myId ? 'Câu hỏi bạn gửi' : `Câu hỏi của ${partnerName}`;
  return q.category;
}
