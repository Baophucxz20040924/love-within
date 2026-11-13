import type { Types } from 'mongoose';
import { WaterLog, type WaterLogDoc, type WaterLogStatus, type WaterSource } from '../models/WaterLog.js';
import { WaterDaily, type WaterDailyDoc } from '../models/WaterDaily.js';

/** Every query is scoped by coupleId (Requirement 3.4). */
export const waterRepository = {
  createLog(input: {
    coupleId: Types.ObjectId;
    userId: Types.ObjectId;
    localDate: string;
    amountMl: number;
    source: WaterSource;
    aiRaw: Record<string, unknown> | null;
    imageKey: string | null;
    status: WaterLogStatus;
  }): Promise<WaterLogDoc> {
    return WaterLog.create(input);
  },

  findLog(coupleId: Types.ObjectId, id: string | Types.ObjectId): Promise<WaterLogDoc | null> {
    return WaterLog.findOne({ _id: id, coupleId }).exec();
  },

  listLogs(coupleId: Types.ObjectId, userId: Types.ObjectId, localDate: string): Promise<WaterLogDoc[]> {
    return WaterLog.find({ coupleId, userId, localDate }).sort({ createdAt: -1 }).exec();
  },

  /** Pending submissions of both members, newest first. */
  listPending(coupleId: Types.ObjectId, limit = 50): Promise<WaterLogDoc[]> {
    return WaterLog.find({ coupleId, status: 'pending' }).sort({ createdAt: -1 }).limit(limit).exec();
  },

  /**
   * Atomically move pending → approved/rejected. Returns null if the log was no longer
   * pending, so a double tap (or both members acting at once) can only apply once.
   */
  review(
    coupleId: Types.ObjectId,
    id: Types.ObjectId,
    status: Exclude<WaterLogStatus, 'pending'>,
    reviewerId: Types.ObjectId,
  ): Promise<WaterLogDoc | null> {
    return WaterLog.findOneAndUpdate(
      { _id: id, coupleId, status: 'pending' },
      { $set: { status, reviewedBy: reviewerId, reviewedAt: new Date() } },
      { new: true },
    ).exec();
  },

  getDaily(coupleId: Types.ObjectId, userId: Types.ObjectId, localDate: string): Promise<WaterDailyDoc | null> {
    return WaterDaily.findOne({ coupleId, userId, localDate }).exec();
  },

  /** Atomically add ml to the daily aggregate (upsert) and refresh the goal snapshot. */
  async addToDaily(
    coupleId: Types.ObjectId,
    userId: Types.ObjectId,
    localDate: string,
    amountMl: number,
    goalMl: number | null,
  ): Promise<WaterDailyDoc> {
    const doc = await WaterDaily.findOneAndUpdate(
      { coupleId, userId, localDate },
      { $inc: { totalMl: amountMl }, $set: { goalMl } },
      { new: true, upsert: true },
    ).exec();
    const goalMet = goalMl !== null && doc.totalMl >= goalMl;
    if (doc.goalMet !== goalMet) {
      doc.goalMet = goalMet;
      await WaterDaily.updateOne({ _id: doc._id }, { $set: { goalMet } }).exec();
    }
    return doc;
  },
};
