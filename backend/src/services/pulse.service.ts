import { performance } from 'node:perf_hooks';
import { observePulseSection } from '../utils/monitor.js';
import type { CoupleDoc } from '../models/Couple.js';
import { eventService, type PulseNextEvent } from './event.service.js';
import { letterService, type PulseLetters } from './letter.service.js';
import { momentService, type PulseMoment } from './moment.service.js';
import { moodService, type PulseMoods } from './mood.service.js';
import { nudgeService, type PulseNudges } from './nudge.service.js';
import { questionService, type PulseQuestionState } from './question.service.js';
import { logger } from '../utils/logger.js';
import { savingsService, type PulseSavings } from './savings.service.js';

/**
 * GET /api/couple/pulse: everything the couple Home screen needs in one request (polled every 30 s while the tab is
 * visible). Shape: plan/ENGINEERING_WORKFLOW.md. Each feature adds its own field when it ships:
 *   recap (CP8).
 *
 * To add a section: add the field to `CouplePulse`, then one builder to `SECTIONS` (TypeScript requires both).
 * Each builder should be one indexed query or two, scoped by couple._id. Builders run in parallel. A builder that
 * throws is logged and its field becomes null, so one broken card never blanks the whole Home screen.
 */
export interface CouplePulse {
  /** CP1: today's question (created on first open) and who has answered, seen from the caller. */
  question: { id: string; state: PulseQuestionState } | null;
  /** CP2: letters to the caller that can be opened now (card "💌 Có thư từ Hà mở được hôm nay") and the next open date. */
  letters: PulseLetters | null;
  /** CP4: nearest event in the next 30 days (null = no "Sắp tới" card). */
  nextEvent: PulseNextEvent | null;
  /** CP5: nudges the caller received today (couple timezone) and the latest one (Hero line, floating hearts). */
  nudges: PulseNudges | null;
  /** CP5: today's mood of the caller and of the partner (Hero). */
  moods: PulseMoods | null;
  /**
   * CP6: today's duo moment from the caller's side (created on first use). windowEndsAt (prompt + 10 min) only once the
   * prompt time has passed, so the time never leaks; Home shows "Khoảnh khắc đang mở" while state is open.
   */
  moment: PulseMoment | null;
  savings: PulseSavings | null;
}

export interface PulseContext {
  couple: CoupleDoc;
  userId: string;
}

type Builders = { [K in keyof CouplePulse]: (ctx: PulseContext) => Promise<CouplePulse[K]> };

const SECTIONS: Builders = {
  question: (ctx) => questionService.pulse(ctx.couple, ctx.userId),
  letters: (ctx) => letterService.pulse(ctx.couple, ctx.userId),
  nextEvent: (ctx) => eventService.pulse(ctx.couple),
  nudges: (ctx) => nudgeService.pulse(ctx.couple, ctx.userId),
  moods: (ctx) => moodService.pulse(ctx.couple, ctx.userId),
  moment: (ctx) => momentService.pulse(ctx.couple, ctx.userId),
  savings: (ctx) => savingsService.pulse(ctx.couple),
};

export const pulseService = {
  async build(couple: CoupleDoc, userId: string): Promise<CouplePulse> {
    const ctx: PulseContext = { couple, userId };
    const keys = Object.keys(SECTIONS) as (keyof CouplePulse)[];
    const values = await Promise.all(
      keys.map(async (key) => {
        const start = performance.now();
        try {
          const value = await SECTIONS[key](ctx);
          observePulseSection(key, value === null ? 'empty' : 'ok', performance.now() - start);
          return value;
        } catch {
          observePulseSection(key, 'error', performance.now() - start);
          logger.warn('Pulse section failed', { section: key });
          return null;
        }
      }),
    );
    return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as unknown as CouplePulse;
  },
};
