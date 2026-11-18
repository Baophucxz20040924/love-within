import { ECONOMY } from '../config/economy.js';
import type { CoupleDoc } from '../models/Couple.js';
import type { CheckinDoc } from '../models/Checkin.js';
import { MOMENT_SCHEDULE_VERSION, type DuoMomentDoc, type MomentPost } from '../models/DuoMoment.js';
import type { DailyRewardSettlementDoc } from '../models/DailyRewardSettlement.js';
import type { RewardIntent, RewardProvenance } from '../models/WalletOperation.js';
import { checkinRepository } from '../repositories/checkin.repository.js';
import { momentRepository } from '../repositories/moment.repository.js';
import { dailyRewardRepository } from '../repositories/dailyReward.repository.js';
import { sortedMembers, splitCoin, walletReview } from '../repositories/wallet.repository.js';
import { walletService } from './wallet.service.js';
import { rewardPolicyService, type RewardPolicyView } from './rewardPolicy.service.js';
import { addDays } from '../utils/date.js';

export interface DailyActivityRewardView {
  policyVersion: 1 | 2;
  effectiveDate: string;
  localDate: string;
  status: 'legacy' | 'waiting' | 'pending' | 'awarded';
  baseCoin: number;
  bonusCoin: number;
  coinAwarded: number;
  commonStreak: number | null;
}
const PAGE = 20;
function bounded(limit: number) { return Number.isSafeInteger(limit) ? Math.max(1, Math.min(PAGE, limit)) : PAGE; }
function view(policy: RewardPolicyView, localDate: string): DailyActivityRewardView {
  return { policyVersion: policy.version, effectiveDate: policy.effectiveDate, localDate,
    status: policy.version === 1 ? 'legacy' : 'waiting', baseCoin: 0, bonusCoin: 0, coinAwarded: 0, commonStreak: null };
}
function isOldIntent(intent: RewardIntent | null | undefined) { return !!intent && intent.provenance?.policyVersion !== 2; }
function both(rows: CheckinDoc[], members: string[]) { return members.every(id => rows.some(row => String(row.userId) === id)); }
function newCheckinSources(rows: CheckinDoc[], members: string[]) {
  return members.every(id => rows.some(row => String(row.userId) === id && row.sourceValid !== false
    && row.rewardIntent?.provenance?.policyVersion === 2 && row.rewardIntent.provenance.component === 'checkin_exp'));
}
function legacyClaim(claim: { status?: string; rewardIntent?: RewardIntent | null } | null | undefined) {
  return !!claim && (isOldIntent(claim.rewardIntent) || (claim.status === 'rewarded' && !claim.rewardIntent));
}
async function oldClaim(couple: CoupleDoc, key: string, localDate: string) {
  return legacyClaim(await dailyRewardRepository.frozenQuest(couple._id, key, localDate));
}
async function finish(row: DailyRewardSettlementDoc): Promise<void> {
  if (row.completedAt) return;
  await walletService.reward({ ...row.intent, coupleId: row.coupleId,
    reason: row.component === 'checkin_pair' ? 'checkin' : 'moment', refId: row._id });
  await dailyRewardRepository.complete(row._id);
  row.completedAt = new Date();
}
function intentFor(localDate: string, component: RewardProvenance['component'],
  memberIds: string[], baseCoin: number, bonusCoin: number, beneficiary: string | null, commonStreak?: number): RewardIntent {
  const perPerson = baseCoin + bonusCoin;
  const coin = perPerson * (beneficiary ? 1 : 2);
  if (!Number.isSafeInteger(coin) || coin < 0) throw walletReview();
  return { operationId: `daily:v2:${component}:${localDate}:${beneficiary ?? 'pair'}`,
    actorUserId: beneficiary ?? memberIds[0], ownerUserId: beneficiary, coin, exp: 0,
    allocations: beneficiary ? { [beneficiary]: coin } : splitCoin(coin, memberIds),
    provenance: { version: 1, source: component === 'checkin_pair' ? 'checkin' : 'moment', localDate,
      policyVersion: 2, component, baseCoin, bonusCoin, ...(commonStreak === undefined ? {} : { commonStreak }) } };
}

/** Only persisted server timestamps decide validity/timeliness; lateMin and request clocks are not evidence. */
export function momentEligibility(day: DuoMomentDoc | null, members: string[]): { photos: Map<string, MomentPost>; timelyPair: boolean } {
  const photos = new Map<string, MomentPost>();
  let timelyPair = false;
  if (!day || day.scheduleVersion !== MOMENT_SCHEDULE_VERSION) return { photos, timelyPair };
  for (const session of day.sessions ?? []) {
    const valid = session.posts.filter(post => members.includes(String(post.userId)) && !!post.key && post.width > 0 && post.height > 0
      && post.postedAt >= session.promptAt && post.postedAt < session.closesAt);
    for (const post of valid) {
      const id = String(post.userId);
      if (!photos.has(id) || photos.get(id)!.postedAt > post.postedAt) photos.set(id, post);
    }
    if (session.rewardEndsAt && members.every(id => valid.some(post => String(post.userId) === id && post.postedAt < session.rewardEndsAt!))) timelyPair = true;
  }
  return { photos, timelyPair };
}
async function momentDay(couple: CoupleDoc, day: DuoMomentDoc | string) {
  if (typeof day !== 'string' && String(day.coupleId) !== String(couple._id)) throw walletReview();
  return typeof day === 'string' ? momentRepository.findDay(couple._id, day) : day;
}

export const dailyRewardService = {
  /** Bounded backwards proof. Never freeze today's streak if an unresolved predecessor lies beyond the bound.
   * Chronological source recovery below advances the oldest days, so repeated jobs make forward progress. */
  async settleCheckins(couple: CoupleDoc, localDate: string, limit = PAGE): Promise<boolean> {
    const policy = await rewardPolicyService.forDay(couple, localDate);
    if (policy.version !== 2) return true;
    const members = sortedMembers(couple.memberIds);
    const stack: { day: string; rows: CheckinDoc[] }[] = [];
    let day = localDate;
    let streak = 0;
    let anchored = false;
    for (let n = 0; n < bounded(limit); n++) {
      if (day < policy.effectiveDate) { anchored = true; break; }
      const settled = await dailyRewardRepository.find(couple._id, day, 'checkin_pair');
      if (settled) { await finish(settled); streak = settled.commonStreak!; anchored = true; break; }
      const rows = await checkinRepository.findForCoupleDate(couple._id, day);
      if (!newCheckinSources(rows, members) || await oldClaim(couple, 'daily_checkin', day)) {
        anchored = true; break;
      }
      stack.push({ day, rows });
      day = addDays(day, -1);
    }
    if (!anchored && day < policy.effectiveDate) anchored = true;
    if (!anchored) return false;
    for (const item of stack.reverse()) {
      streak += 1;
      const baseCoin = ECONOMY.dailyRewards.checkinBase;
      const bonusCoin = (streak - 1) * ECONOMY.dailyRewards.checkinStreakPerDay;
      if (!Number.isSafeInteger(streak) || !Number.isSafeInteger(bonusCoin)) throw walletReview();
      const frozen = await dailyRewardRepository.ensure({ coupleId: couple._id, localDate: item.day, component: 'checkin_pair',
        beneficiary: 'pair', memberIds: members, commonStreak: streak, baseCoin, bonusCoin,
        intent: intentFor(item.day, 'checkin_pair', members, baseCoin, bonusCoin, null, streak) });
      // The winning create-once intent is authoritative, including under retries/concurrency.
      await finish(frozen);
      streak = frozen.commonStreak!;
    }
    return true;
  },

  async getCheckinRewardView(couple: CoupleDoc, localDate: string, userId: string): Promise<DailyActivityRewardView> {
    const policy = await rewardPolicyService.forDay(couple, localDate);
    const result = view(policy, localDate);
    if (policy.version !== 2) return result;
    const rows = await checkinRepository.findForCoupleDate(couple._id, localDate);
    if (rows.some(row => isOldIntent(row.rewardIntent)) || await oldClaim(couple, 'daily_checkin', localDate)) return { ...result, policyVersion: 1, status: 'legacy' };
    const members = sortedMembers(couple.memberIds);
    if (!members.includes(userId)) throw walletReview();
    if (!both(rows, members)) return result;
    if (!newCheckinSources(rows, members)) return { ...result, policyVersion: 1, status: 'legacy' };
    const row = await dailyRewardRepository.find(couple._id, localDate, 'checkin_pair');
    return { ...result, status: row?.completedAt ? 'awarded' : 'pending', baseCoin: row?.baseCoin ?? ECONOMY.dailyRewards.checkinBase,
      bonusCoin: row?.bonusCoin ?? 0, commonStreak: row?.commonStreak ?? null,
      coinAwarded: row?.completedAt ? row.intent.allocations?.[userId] ?? 0 : 0 };
  },

  async settleMoments(couple: CoupleDoc, dayOrDate: DuoMomentDoc | string): Promise<void> {
    const day = await momentDay(couple, dayOrDate);
    if (!day) return;
    const policy = await rewardPolicyService.forDay(couple, day.localDate);
    if (policy.version !== 2 || await oldClaim(couple, 'duo_moment', day.localDate)) return;
    const members = sortedMembers(couple.memberIds);
    const eligible = momentEligibility(day, members);
    for (const member of members) {
      if (!eligible.photos.has(member)) continue;
      const baseCoin = ECONOMY.dailyRewards.momentPhoto;
      await finish(await dailyRewardRepository.ensure({ coupleId: couple._id, localDate: day.localDate, component: 'photo_base',
        beneficiary: member, memberIds: members, commonStreak: null, baseCoin, bonusCoin: 0,
        intent: intentFor(day.localDate, 'photo_base', members, baseCoin, 0, member) }));
    }
    if (eligible.timelyPair) {
      const bonusCoin = ECONOMY.dailyRewards.momentTimelyPair;
      await finish(await dailyRewardRepository.ensure({ coupleId: couple._id, localDate: day.localDate, component: 'timely_pair_bonus',
        beneficiary: 'pair', memberIds: members, commonStreak: null, baseCoin: 0, bonusCoin,
        intent: intentFor(day.localDate, 'timely_pair_bonus', members, 0, bonusCoin, null) }));
    }
  },

  async getMomentRewardView(couple: CoupleDoc, dayOrDate: DuoMomentDoc | string, userId: string): Promise<DailyActivityRewardView> {
    const day = await momentDay(couple, dayOrDate);
    const localDate = typeof dayOrDate === 'string' ? dayOrDate : dayOrDate.localDate;
    if (!day) return view(await rewardPolicyService.forDay(couple, localDate), localDate);
    return (await dailyRewardService.getMomentRewardViews(couple, [day], userId)).get(localDate)!;
  },

  /** Fixed query count for a calendar page; provenance is read directly, never N+1 source inference. */
  async getMomentRewardViews(couple: CoupleDoc, days: DuoMomentDoc[], userId: string): Promise<Map<string, DailyActivityRewardView>> {
    if (days.length > 31) throw walletReview();
    const stored = await rewardPolicyService.ensure(couple);
    const members = sortedMembers(couple.memberIds);
    if (!members.includes(userId) || days.some(day => String(day.coupleId) !== String(couple._id))) throw walletReview();
    const dates = days.map(day => day.localDate).filter(day => day >= stored.effectiveDate);
    const [settlements, claims] = dates.length ? await Promise.all([
      dailyRewardRepository.listDays(couple._id, dates), dailyRewardRepository.frozenMomentQuests(couple._id, dates),
    ]) : [[], []];
    const oldDays = new Set(claims.filter(legacyClaim).map(claim => claim.localDate));
    const result = new Map<string, DailyActivityRewardView>();
    for (const day of days) {
      const policy: RewardPolicyView = { version: day.localDate >= stored.effectiveDate ? 2 : 1, effectiveDate: stored.effectiveDate, timezone: stored.timezone };
      let reward = view(policy, day.localDate);
      if (policy.version !== 2 || day.scheduleVersion !== MOMENT_SCHEDULE_VERSION || oldDays.has(day.localDate)) {
        reward = { ...reward, policyVersion: 1, status: 'legacy' };
      } else {
        const eligible = momentEligibility(day, members);
        if (eligible.photos.has(userId)) {
          const base = settlements.find(row => row.localDate === day.localDate && row.component === 'photo_base' && row.beneficiary === userId);
          const bonus = settlements.find(row => row.localDate === day.localDate && row.component === 'timely_pair_bonus');
          reward = { ...reward, baseCoin: ECONOMY.dailyRewards.momentPhoto, bonusCoin: eligible.timelyPair ? ECONOMY.dailyRewards.momentTimelyPair : 0,
            coinAwarded: (base?.completedAt ? base.intent.allocations?.[userId] ?? 0 : 0) + (bonus?.completedAt ? bonus.intent.allocations?.[userId] ?? 0 : 0),
            status: base?.completedAt && (!eligible.timelyPair || bonus?.completedAt) ? 'awarded' : 'pending' };
        }
      }
      result.set(day.localDate, reward);
    }
    return result;
  },

  /** Scheduler and wallet reads share bounded chronological repair, including source commits BEFORE intent creation. */
  async recoverCouple(couple: CoupleDoc, limit = PAGE): Promise<void> {
    const size = bounded(limit);
    await rewardPolicyService.ensure(couple);
    const sources = await dailyRewardRepository.pendingCheckins(couple._id, size);
    for (const day of [...new Set(sources.map(row => row.localDate))].sort()) {
      if (await dailyRewardService.settleCheckins(couple, day, size)) {
        await dailyRewardRepository.clearCheckins(sources.filter(row => row.localDate === day).map(row => row._id));
      }
    }
    for (const day of await dailyRewardRepository.pendingMoments(couple._id, size)) {
      await dailyRewardService.settleMoments(couple, day);
      await dailyRewardRepository.clearMoment(day);
    }
    for (const row of await dailyRewardRepository.pending(couple._id, size)) await finish(row);
  },
};
