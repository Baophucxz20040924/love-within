import type { Types } from 'mongoose';
import { Checkin, type CheckinDoc } from '../models/Checkin.js';

export const checkinRepository = {
  findByDate(coupleId: Types.ObjectId, userId: Types.ObjectId, localDate: string): Promise<CheckinDoc | null> {
    return Checkin.findOne({ coupleId, userId, localDate }).exec();
  },

  findLatest(coupleId: Types.ObjectId, userId: Types.ObjectId): Promise<CheckinDoc | null> {
    return Checkin.findOne({ coupleId, userId, sourceValid: { $ne: false } }).sort({ localDate: -1 }).exec();
  },

  /** Throws a MongoServerError with code 11000 on duplicate (same user, same day). */
  async create(input: {
    coupleId: Types.ObjectId;
    userId: Types.ObjectId;
    localDate: string;
    streak: number;
    coinAwarded: number;
    expAwarded: number;
    dailySettlementPending?: boolean;
    dayOpensAt?: Date;
    dayClosesAt?: Date;
    rewardIntent: import('../models/WalletOperation.js').RewardIntent;
  }): Promise<CheckinDoc> {
    if (!input.dayOpensAt || !input.dayClosesAt) return Checkin.create(input);
    const { dayOpensAt, dayClosesAt, ...fields } = input;
    const valid = { $and: [{ $gte: ['$$NOW', dayOpensAt] }, { $lt: ['$$NOW', dayClosesAt] }] };
    // Server-time fence: an in-flight yesterday request cannot create a completed predecessor after
    // today's streak was finalized. Invalid boundary rows are inert and never eligible for EXP/coins.
    return Checkin.findOneAndUpdate({ coupleId: input.coupleId, userId: input.userId, localDate: input.localDate, sourceValid: false }, [{ $set: {
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $literal: value }])),
      createdAt: '$$NOW', sourceValid: valid, dailySettlementPending: valid,
      rewardIntent: { $cond: [valid, { $literal: fields.rewardIntent }, null] }, rewardCompletedAt: null,
    } }], { upsert: true, new: true, timestamps: false }).orFail().exec();
  },

  /** Check-ins for the couple on a given day (both members). */
  findForCoupleDate(coupleId: Types.ObjectId, localDate: string): Promise<CheckinDoc[]> {
    return Checkin.find({ coupleId, localDate, sourceValid: { $ne: false } }).exec();
  },
};
