import { Types } from 'mongoose';
import {
  AssistantThread,
  MAX_THREAD_MESSAGES,
  type AssistantInsights,
  type AssistantMessage,
  type AssistantThreadDoc,
} from '../models/AssistantThread.js';

/** Every query is scoped by userId (the owner). */
export const assistantThreadRepository = {
  findByUser(userId: Types.ObjectId): Promise<AssistantThreadDoc | null> {
    return AssistantThread.findOne({ userId }).exec();
  },

  /** Append one question + answer, keeping only the last MAX_THREAD_MESSAGES. */
  async appendExchange(userId: Types.ObjectId, question: AssistantMessage, reply: AssistantMessage): Promise<void> {
    await AssistantThread.updateOne(
      { userId },
      { $push: { messages: { $each: [question, reply], $slice: -MAX_THREAD_MESSAGES } } },
      { upsert: true, runValidators: true },
    ).exec();
  },

  async setInsights(userId: Types.ObjectId, insights: AssistantInsights): Promise<void> {
    await AssistantThread.updateOne({ userId }, { $set: { insights } }, { upsert: true }).exec();
  },

  async deleteByUser(userId: Types.ObjectId): Promise<number> {
    const res = await AssistantThread.deleteOne({ userId }).exec();
    return res.deletedCount;
  },
};
