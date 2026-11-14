import type { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import type { UserDoc } from '../models/User.js';

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user id (set by requireAuth). */
      userId?: string;
      /** Verified effective access token deadline. */
      accessExpiresAtMs?: number;
      /** Couple id for the authenticated user (set by requireCouple). */
      coupleId?: Types.ObjectId;
      /** Active couple document (set by requireCouple). */
      couple?: CoupleDoc;
      /** Caller, already a member of the hidden friends space (set by requireFriendsMember). */
      friendsMember?: UserDoc;
    }
  }
}

export {};
