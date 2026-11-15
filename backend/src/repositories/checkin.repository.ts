import type { Types } from 'mongoose';
import { Checkin, type CheckinDoc } from '../models/Checkin.js';

export const checkinRepository = {
  findByDate(coupleId: Types.ObjectId, userId: Types.ObjectId, localDate: string): Promise<CheckinDoc | null> {
    return Checkin.findOne({ coupleId, userId, localDate }).exec();
  },

  findLatest(coupleId: Types.ObjectId, userId: Types.ObjectId): Promise<CheckinDoc | null> {
    return Checkin.findOne({ coupleId, userId }).sort({ localDate: -1 }).exec();
  },

  /** Throws a MongoServerError with code 11000 on duplicate (same user, same day). */
  create(input: {
    coupleId: Types.ObjectId;
    userId: Types.ObjectId;
    localDate: string;
    streak: number;
    coinAwarded: number;
    expAwarded: number;
    rewardIntent: import('../models/WalletOperation.js').RewardIntent;
  }): Promise<CheckinDoc> {
    return Checkin.create(input);
  },

  /** Check-ins for the couple on a given day (both members). */
  findForCoupleDate(coupleId: Types.ObjectId, localDate: string): Promise<CheckinDoc[]> {
    return Checkin.find({ coupleId, localDate }).exec();
  },
};
