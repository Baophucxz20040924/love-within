import { userRepository } from '../repositories/user.repository.js';
import { realtimeAudience } from './realtimeAudience.service.js';

/** Finance activity stays owner-only unless the owner has explicitly shared it.
 * Visibility changes also invalidate the previous reader without disclosing data. */
export async function publishFinanceChange(userId: string, options: { access?: boolean; visibilityChanged?: boolean } = {}): Promise<void> {
  try {
    await realtimeAudience.own(userId, 'couple', options.visibilityChanged ? ['finance', 'assistant', 'account'] : ['finance', 'assistant'], options.access);
    const user = await userRepository.findById(userId);
    if (user && (options.visibilityChanged || user.financeVisibility === 'partner')) {
      await realtimeAudience.coupleForUser(userId, ['finance'], options.access);
    }
  } catch {
    // Realtime is best effort; a failed hint must not change the persisted outcome.
  }
}
