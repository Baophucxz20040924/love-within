import { Types, type PipelineStage } from 'mongoose';
import { ScamGamePlayer, SCAM_RULE_VERSION, type ScamPlayer } from '../models/ScamGamePlayer.js';
import { User } from '../models/User.js';
import { Friendship } from '../models/Friendship.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Reused before pagination and ranking; never truncate the viewer's accepted friendships. */
function boardEligibility(viewer: Types.ObjectId, blocked: string[]): PipelineStage[] {
  const viewerId = String(viewer);
  return [
    { $match: { ruleVersion: SCAM_RULE_VERSION, completed: { $gt: 0 }, _id: { $nin: blocked.map(id => new Types.ObjectId(id)) } } },
    { $project: { _id: 1, bestScore: 1, wins: 1 } },
    { $addFields: { pairKey: { $cond: [
      { $lt: [{ $toString: '$_id' }, viewerId] },
      { $concat: [{ $toString: '$_id' }, ':', viewerId] },
      { $concat: [viewerId, ':', { $toString: '$_id' }] },
    ] } } },
    { $lookup: { from: Friendship.collection.name, localField: 'pairKey', foreignField: 'pairKey', as: 'friendship' } },
    { $match: { $or: [{ _id: viewer }, { friendship: { $elemMatch: { status: 'accepted' } } }] } },
    { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', as: 'member' } },
    { $match: { member: { $elemMatch: { friendsJoinedAt: { $exists: true, $ne: null } } } } },
    { $project: { _id: 1, bestScore: 1, wins: 1 } },
  ];
}
interface BoardRow { _id: Types.ObjectId; bestScore: number; wins: number }

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
  async cas(previous: ScamPlayer, next: ScamPlayer, deadline?: number): Promise<boolean> {
    const result = await ScamGamePlayer.replaceOne({ _id: previous._id, revision: previous.revision,
      ...(deadline !== undefined ? { $expr: { $lt: ['$$NOW', new Date(deadline)] } } : {}),
    }, { ...next, revision: previous.revision + 1 }).exec();
    return result.modifiedCount === 1;
  },
  async leaderboard(viewer: Types.ObjectId, blocked: string[], limit: number, after?: ScamBoardPosition) {
    const started = Date.now();
    try {
      const eligible = boardEligibility(viewer, blocked);
      const rows = await ScamGamePlayer.aggregate<BoardRow>([
        ...eligible,
        ...(after ? [{ $match: { $or: [
          { bestScore: { $lt: after.score } },
          { bestScore: after.score, wins: { $lt: after.wins } },
          { bestScore: after.score, wins: after.wins, _id: { $gt: new Types.ObjectId(after.id) } },
        ] } }] : []),
        { $sort: { bestScore: -1, wins: -1, _id: 1 } }, { $limit: limit + 1 },
      ]).option({ maxTimeMS: 3000 }).exec();
      if (!rows.length) return [];
      const tuples = [...new Map(rows.slice(0, limit).map(row => [`${row.bestScore}:${row.wins}`, row])).values()];
      // Count players, not groups. No cursor/limit here: ties retain their rank across pages.
      const counters = Object.fromEntries(tuples.map((row, index) => [`r${index}`, { $sum: { $cond: [
        { $or: [{ $gt: ['$bestScore', row.bestScore] }, { $and: [
          { $eq: ['$bestScore', row.bestScore] }, { $gt: ['$wins', row.wins] },
        ] }] }, 1, 0,
      ] } }]));
      const [counts] = await ScamGamePlayer.aggregate<Record<string, number>>([
        ...eligible, { $group: { _id: null, ...counters } },
      ]).option({ maxTimeMS: 3000 }).exec();
      const ranks = new Map(tuples.map((row, index) => [`${row.bestScore}:${row.wins}`, 1 + (counts?.[`r${index}`] ?? 0)]));
      // The extra row is only a continuation sentinel; its rank is not serialized by the service.
      return rows.map(row => ({ ...row, rank: ranks.get(`${row.bestScore}:${row.wins}`) ?? 0 }));
    } catch (error) {
      const timeout = (error as { code?: unknown })?.code === 50;
      const code = timeout ? 'SCAM_BOARD_TIMEOUT' : 'SCAM_BOARD_UNAVAILABLE';
      logger.warn('Scam board read failed', { code, elapsedMs: Date.now() - started });
      throw new AppError(503, code, timeout ? 'Bảng xếp hạng đang phản hồi chậm. Thử lại sau nhé.' : 'Bảng xếp hạng tạm thời chưa tải được. Thử lại sau nhé.');
    }
  },
};
