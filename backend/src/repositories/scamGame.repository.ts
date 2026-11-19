import { Types, type PipelineStage } from 'mongoose';
import { ScamGamePlayer, SCAM_RULE_VERSION, type ScamPlayer } from '../models/ScamGamePlayer.js';
import { User } from '../models/User.js';

export interface ScamBoardPosition { score: number; wins: number; id: string }
export const scamGameRepository = {
  async get(userId: Types.ObjectId): Promise<ScamPlayer> {
    let row = await ScamGamePlayer.findById(userId).lean<ScamPlayer>().exec();
    if (row) return row;
    try {
      await ScamGamePlayer.create({ _id: userId, revision: 0, ruleVersion: SCAM_RULE_VERSION, bestScore: 0, wins: 0, completed: 0, match: null, pending: null, receipts: [] });
    } catch (error) { if ((error as { code?: number })?.code !== 11000) throw error; }
    row = await ScamGamePlayer.findById(userId).lean<ScamPlayer>().exec();
    if (!row) throw new Error('Game state unavailable');
    return row;
  },
  async cas(previous: ScamPlayer, next: ScamPlayer): Promise<boolean> {
    const result = await ScamGamePlayer.replaceOne({ _id: previous._id, revision: previous.revision }, { ...next, revision: previous.revision + 1 }).exec();
    return result.modifiedCount === 1;
  },
  async leaderboard(blocked: string[], limit: number, after?: ScamBoardPosition) {
    // Exact visible competition ranks need a scan/window. Limit bounds payload, not examined rows.
    const pipeline: PipelineStage[] = [
      { $match: { ruleVersion: SCAM_RULE_VERSION, completed: { $gt: 0 }, _id: { $nin: blocked.map(id => new Types.ObjectId(id)) } } },
      { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', as: 'member', pipeline: [
        { $match: { friendsJoinedAt: { $ne: null } } }, { $project: { _id: 1 } },
      ] } },
      { $match: { 'member.0': { $exists: true } } },
      { $project: { _id: 1, bestScore: 1, wins: 1 } },
      { $setWindowFields: { sortBy: { bestScore: -1, wins: -1, _id: 1 }, output: { position: { $documentNumber: {} } } } },
      { $setWindowFields: { partitionBy: { score: '$bestScore', wins: '$wins' }, output: { rank: { $min: '$position', window: { documents: ['unbounded', 'unbounded'] } } } } },
      ...(after ? [{ $match: { $or: [
        { bestScore: { $lt: after.score } },
        { bestScore: after.score, wins: { $lt: after.wins } },
        { bestScore: after.score, wins: after.wins, _id: { $gt: new Types.ObjectId(after.id) } },
      ] } }] : []),
      { $sort: { bestScore: -1, wins: -1, _id: 1 } }, { $limit: limit + 1 },
      { $project: { _id: 1, bestScore: 1, wins: 1, rank: 1 } },
    ];
    return ScamGamePlayer.aggregate<{ _id: Types.ObjectId; bestScore: number; wins: number; rank: number }>(pipeline).option({ maxTimeMS: 3000 }).exec();
  },
};
