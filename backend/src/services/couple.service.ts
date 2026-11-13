import type { CoupleDoc } from '../models/Couple.js';
import { userRepository } from '../repositories/user.repository.js';
import { daysBetween } from '../utils/date.js';
import { avatarUrlOf } from './profile.service.js';

/** Milestones (in days) highlighted on the Home screen. */
export const MILESTONES = [100, 200, 365, 500, 730, 1000, 1095, 1460, 1825, 2000, 3650];

export interface CoupleView {
  id: string;
  memberIds: string[];
  members: { id: string; displayName: string; email: string; avatarUrl: string | null }[];
  anniversaryDate: string | null;
  daysInLove: number | null;
  nextMilestone: { days: number; remaining: number } | null;
  lastMilestone: number | null;
  level: number;
  exp: number;
  timezone: string;
}

export async function buildCoupleView(couple: CoupleDoc): Promise<CoupleView> {
  const members = await Promise.all(couple.memberIds.map((id) => userRepository.findById(id)));
  const daysInLove = couple.anniversaryDate ? daysBetween(couple.anniversaryDate, couple.timezone) : null;

  let nextMilestone: CoupleView['nextMilestone'] = null;
  let lastMilestone: number | null = null;
  if (daysInLove !== null) {
    const next = MILESTONES.find((m) => m > daysInLove);
    if (next) nextMilestone = { days: next, remaining: next - daysInLove };
    const passed = MILESTONES.filter((m) => m <= daysInLove);
    lastMilestone = passed.length ? passed[passed.length - 1] : null;
  }

  return {
    id: couple._id.toString(),
    memberIds: couple.memberIds.map((m) => m.toString()),
    members: await Promise.all(
      members
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .map(async (m) => ({ id: m._id.toString(), displayName: m.displayName, email: m.email, avatarUrl: await avatarUrlOf(m.avatarKey) })),
    ),
    anniversaryDate: couple.anniversaryDate ? couple.anniversaryDate.toISOString() : null,
    daysInLove,
    nextMilestone,
    lastMilestone,
    level: couple.level,
    exp: couple.exp,
    timezone: couple.timezone,
  };
}
