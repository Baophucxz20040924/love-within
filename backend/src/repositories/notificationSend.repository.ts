import { NotificationSend } from '../models/NotificationSend.js';

/** Not scoped by couple or user: keys are global and hold ids only (see models/NotificationSend.ts). */
export const notificationSendRepository = {
  /** Insert the key. True for the first caller, false when the key exists already (duplicate key 11000). */
  async claim(key: string): Promise<boolean> {
    try {
      // sentAt is the real clock (not a dev "now" override), so the TTL always counts from the actual insert.
      await NotificationSend.create({ key, sentAt: new Date() });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  },

  /** Which of these keys were claimed already (one indexed read instead of one failed insert per key). */
  async existing(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const docs = await NotificationSend.find({ key: { $in: keys } })
      .select('key')
      .lean<{ key: string }[]>()
      .exec();
    return new Set(docs.map((d) => d.key));
  },
};
