import { realtimeAudience } from './realtimeAudience.service.js';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import type { CoupleDoc } from '../models/Couple.js';
import { MAX_LETTER_PHOTOS, MAX_LETTER_YEARS, type CoupleLetterDoc, type LetterPhoto } from '../models/CoupleLetter.js';
import { getStorage } from '../integrations/index.js';
import { letterRepository, type LetterContent } from '../repositories/letter.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { STORY_IMAGE_TYPES } from './story.service.js';
import { notificationService } from './notification.service.js';
import { addDays, daysUntil, getLocalDate, yearlyDateIn, zonedTimeToUtc } from '../utils/date.js';
import { AppError, Errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// "Thư hẹn giờ" (plan/ENGINEERING_WORKFLOW.md, CP2). Privacy rules, enforced here and nowhere else:
// - The recipient gets no title, body or photo before openAt (server clock): GET → 403 LETTER_SEALED, the list has no title.
// - Content (and presigned photo URLs) reach the recipient only from the first open on (POST /open writes openedAt once).
// - The author always reads the letter, and edits or deletes it until it is opened (then 409 LETTER_OPENED).
// Titles and bodies are never logged and never sent to the AI.

export interface LetterInput {
  title: string;
  body: string;
  openOn: string;
  photos: LetterPhoto[];
}

interface Person {
  id: string;
  displayName: string;
}

export interface LetterSummary {
  id: string;
  from: Person;
  to: Person;
  /** I wrote it. */
  isMine: boolean;
  /** "YYYY-MM-DD", couple timezone. */
  openOn: string;
  /** Days from today (couple timezone) to openOn: 0 = today, negative = past. */
  daysLeft: number;
  /** The open time has come (server clock ≥ 00:00 of openOn in the couple timezone). */
  openable: boolean;
  openedAt: string | null;
  createdAt: string;
  /** Mine: always. To me: only once openable. */
  title?: string;
}

export interface LetterPhotoView {
  key: string;
  url: string;
  width: number;
  height: number;
}

export interface LetterView extends LetterSummary {
  /** The author always gets it; the recipient only after the first open. null = still closed for me. */
  content: { title: string; body: string; photos: LetterPhotoView[] } | null;
  /** Only alongside the content. */
  editedAt: string | null;
}

export interface LetterList {
  /** "Thư cho bạn": openable first (oldest first), then sealed (soonest first), then opened (latest open first). */
  inbox: LetterSummary[];
  /** "Thư bạn đã gửi", newest first. */
  sent: LetterSummary[];
}

/** GET /api/couple/pulse → letters (Home card "💌 Có thư từ Hà mở được hôm nay"), from the caller's side as recipient. */
export interface PulseLetters {
  /** Unopened letters to me whose time has come. */
  openable: number;
  /** The oldest of them (the card links straight to it when there is one). */
  openableId: string | null;
  /** Open date of my next sealed letter. */
  nextOpenOn: string | null;
}

type Names = Map<string, string>;

const notFound = () => Errors.notFound('Thư không tồn tại hoặc đã bị xóa');
const opened409 = () => new AppError(409, 'LETTER_OPENED', 'Thư đã được mở nên không sửa hay xóa được nữa.');
const notAuthor = () => Errors.forbidden('Chỉ người viết mới sửa hoặc xóa được thư này');

function formatDayVi(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

function letterPrefix(coupleId: Types.ObjectId): string {
  return `couples/${coupleId.toString()}/letters/`;
}

function partnerOf(couple: CoupleDoc, userId: string): Types.ObjectId | null {
  return couple.memberIds.find((m) => m.toString() !== userId) ?? null;
}

function todayOf(couple: CoupleDoc): string {
  return getLocalDate(new Date(), couple.timezone);
}

/** Open dates allowed when writing: tomorrow … the same day in 20 years (29/02 → 28/02), couple timezone. */
export function openDateRange(today: string): { min: string; max: string } {
  return { min: addDays(today, 1), max: yearlyDateIn(today, Number(today.slice(0, 4)) + MAX_LETTER_YEARS) };
}

function person(id: Types.ObjectId, names: Names): Person {
  const key = id.toString();
  return { id: key, displayName: names.get(key) ?? 'Người ấy' };
}

function toSummary(l: CoupleLetterDoc, userId: string, names: Names, now: Date, today: string): LetterSummary {
  const isMine = l.authorId.toString() === userId;
  const openable = l.openAt.getTime() <= now.getTime();
  const summary: LetterSummary = {
    id: l._id.toString(),
    from: person(l.authorId, names),
    to: person(l.recipientId, names),
    isMine,
    openOn: l.openOn,
    daysLeft: daysUntil(today, l.openOn),
    openable,
    openedAt: l.openedAt ? l.openedAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
  };
  if (isMine || openable) summary.title = l.title;
  return summary;
}

async function toView(l: CoupleLetterDoc, userId: string, names: Names, now: Date, today: string): Promise<LetterView> {
  const summary = toSummary(l, userId, names, now, today);
  // Presigned photo URLs are created only here, when the content is returned.
  if (!summary.isMine && !l.openedAt) return { ...summary, content: null, editedAt: null };
  const storage = getStorage();
  const photos = await Promise.all(
    l.photos.map(async (p) => ({
      key: p.key,
      width: p.width,
      height: p.height,
      url: (await storage.getDownloadUrl(p.key, { cacheable: true })).url,
    })),
  );
  return {
    ...summary,
    content: { title: l.title, body: l.body, photos },
    editedAt: l.editedAt ? l.editedAt.toISOString() : null,
  };
}

/** 403 for the recipient before the open time. `details.letter` is the envelope only (no title, body or photos). */
function sealed(summary: LetterSummary): AppError {
  return new AppError(403, 'LETTER_SEALED', `Thư này mở được từ ngày ${formatDayVi(summary.openOn)}.`, { letter: summary });
}

/**
 * Trim and check the open date. An edit that keeps the current open date keeps its openAt, so the author can still fix a
 * letter whose day has come but that was not opened yet.
 */
function normalize(couple: CoupleDoc, input: LetterInput, current: CoupleLetterDoc | null): LetterContent {
  const body = input.body.trim();
  if (!body) throw Errors.badRequest('Hãy viết vài dòng cho người ấy');
  let openAt: Date;
  if (current && input.openOn === current.openOn) {
    openAt = current.openAt;
  } else {
    const { min, max } = openDateRange(todayOf(couple));
    if (input.openOn < min) throw Errors.badRequest('Ngày mở thư phải từ ngày mai trở đi');
    if (input.openOn > max) throw Errors.badRequest(`Ngày mở thư tối đa là ${MAX_LETTER_YEARS} năm nữa`);
    openAt = zonedTimeToUtc(input.openOn, '00:00', couple.timezone);
  }
  return {
    title: input.title.trim(),
    body,
    photos: input.photos.map((p) => ({ key: p.key, width: p.width, height: p.height })),
    openOn: input.openOn,
    openAt,
  };
}

/** Photos must be under this couple's letters prefix and really exist in storage (same rule as stories). */
async function validatePhotos(couple: CoupleDoc, userId: string, photos: LetterPhoto[], alreadyAttached: Set<string>): Promise<void> {
  if (photos.length > MAX_LETTER_PHOTOS) throw Errors.badRequest(`Tối đa ${MAX_LETTER_PHOTOS} ảnh mỗi lá thư`);
  const prefix = letterPrefix(couple._id);
  const seen = new Set<string>();
  const toCheck: string[] = [];
  for (const p of photos) {
    if (!p.key.startsWith(prefix) || p.key.includes('..')) {
      logger.warn('Rejected foreign letter photo key', { coupleId: couple._id.toString(), userId, key: p.key });
      throw Errors.forbidden('Ảnh không thuộc couple của bạn');
    }
    if (seen.has(p.key)) throw Errors.badRequest('Có ảnh bị trùng');
    seen.add(p.key);
    if (!alreadyAttached.has(p.key)) toCheck.push(p.key);
  }
  const heads = await Promise.all(toCheck.map((key) => getStorage().headObject(key)));
  for (const head of heads) {
    if (!head) throw Errors.badRequest('Có ảnh chưa tải lên xong. Thử gửi lại nhé.');
    if (head.size > env.s3.maxUploadBytes) throw Errors.badRequest('Ảnh vượt kích thước cho phép');
  }
}

function sameContent(a: LetterContent, b: CoupleLetterDoc): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.openOn === b.openOn &&
    a.photos.length === b.photos.length &&
    a.photos.every((p, i) => p.key === b.photos[i].key)
  );
}

async function requireLetter(couple: CoupleDoc, id: string): Promise<CoupleLetterDoc> {
  const letter = await letterRepository.findById(couple._id, id);
  if (!letter) throw notFound();
  return letter;
}

function memberNames(couple: CoupleDoc): Promise<Names> {
  return userRepository.findDisplayNames(couple.memberIds);
}

/** Display order of "Thư cho bạn": ready to open, then sealed, then already opened. */
function inboxRank(s: LetterSummary): number {
  if (s.openedAt) return 2;
  return s.openable ? 0 : 1;
}

export const letterService = {
  async list(couple: CoupleDoc, userId: string): Promise<LetterList> {
    const uid = new Types.ObjectId(userId);
    const [inbox, sent, names] = await Promise.all([
      letterRepository.listInbox(couple._id, uid),
      letterRepository.listSent(couple._id, uid),
      memberNames(couple),
    ]);
    const now = new Date();
    const today = todayOf(couple);
    const inboxViews = inbox
      .map((l) => toSummary(l, userId, names, now, today))
      .sort((a, b) => {
        const rank = inboxRank(a) - inboxRank(b);
        if (rank !== 0) return rank;
        // Opened: latest open first. Others keep the repository order (soonest open time first).
        return inboxRank(a) === 2 ? (b.openedAt ?? '').localeCompare(a.openedAt ?? '') : 0;
      });
    return { inbox: inboxViews, sent: sent.map((l) => toSummary(l, userId, names, now, today)) };
  },

  /** The author always; the recipient: 403 LETTER_SEALED before the open time, content only after the first open. */
  async get(couple: CoupleDoc, userId: string, id: string): Promise<LetterView> {
    const [letter, names] = await Promise.all([requireLetter(couple, id), memberNames(couple)]);
    const now = new Date();
    const today = todayOf(couple);
    const isMine = letter.authorId.toString() === userId;
    if (!isMine && letter.openAt.getTime() > now.getTime()) throw sealed(toSummary(letter, userId, names, now, today));
    return toView(letter, userId, names, now, today);
  },

  async createUploadUrl(couple: CoupleDoc, mimeType: string, sizeBytes: number) {
    const ext = STORY_IMAGE_TYPES[mimeType];
    if (!ext) throw Errors.badRequest('Chỉ chấp nhận ảnh JPEG/PNG/WebP');
    if (sizeBytes <= 0 || sizeBytes > env.s3.maxUploadBytes) {
      throw Errors.badRequest(`Ảnh phải ≤ ${Math.round(env.s3.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const month = todayOf(couple).slice(0, 7);
    const imageKey = `${letterPrefix(couple._id)}${month}/${randomUUID()}.${ext}`;
    const { uploadUrl, expiresIn } = await getStorage().getUploadUrl({ key: imageKey, mimeType, sizeBytes });
    return { uploadUrl, imageKey, expiresIn, maxBytes: env.s3.maxUploadBytes };
  },

  /** To the partner; open date tomorrow … 20 years. */
  async create(couple: CoupleDoc, userId: string, input: LetterInput): Promise<LetterView> {
    const recipientId = partnerOf(couple, userId);
    if (!recipientId) throw Errors.badRequest('Bạn cần ghép đôi để gửi thư');
    const content = normalize(couple, input, null);
    await validatePhotos(couple, userId, content.photos, new Set());
    const letter = await letterRepository.create({ ...content, coupleId: couple._id, authorId: new Types.ObjectId(userId), recipientId });
    await realtimeAudience.couple(couple._id, ['letters']);
    logger.info('Letter created', {
      coupleId: couple._id.toString(),
      userId,
      letterId: letter._id.toString(),
      openOn: letter.openOn,
      photos: content.photos.length,
    });
    return toView(letter, userId, await memberNames(couple), new Date(), todayOf(couple));
  },

  /** Author only, until opened. Removes dropped photos from storage (best effort), like story edits. */
  async update(couple: CoupleDoc, userId: string, id: string, input: LetterInput): Promise<LetterView> {
    const current = await requireLetter(couple, id);
    if (current.authorId.toString() !== userId) throw notAuthor();
    if (current.openedAt) throw opened409();
    const content = normalize(couple, input, current);
    const names = await memberNames(couple);
    if (sameContent(content, current)) return toView(current, userId, names, new Date(), todayOf(couple));

    await validatePhotos(couple, userId, content.photos, new Set(current.photos.map((p) => p.key)));
    const uid = new Types.ObjectId(userId);
    const updated = await letterRepository.updateContent(couple._id, current._id, uid, content, content.openOn !== current.openOn);
    if (!updated) {
      // Opened (or deleted) a moment ago.
      const again = await letterRepository.findById(couple._id, id);
      throw again?.openedAt ? opened409() : notFound();
    }

    await realtimeAudience.couple(couple._id, ['letters']);
    const kept = new Set(content.photos.map((p) => p.key));
    const dropped = current.photos.filter((p) => !kept.has(p.key));
    await Promise.all(
      dropped.map((p) =>
        getStorage()
          .deleteObject(p.key)
          .catch((err: Error) => logger.warn('Could not delete dropped letter photo', { key: p.key, message: err.message })),
      ),
    );
    logger.info('Letter edited', {
      coupleId: couple._id.toString(),
      userId,
      letterId: id,
      openOn: updated.openOn,
      droppedPhotos: dropped.length,
    });
    return toView(updated, userId, names, new Date(), todayOf(couple));
  },

  /** Author only, until opened (soft delete). */
  async remove(couple: CoupleDoc, userId: string, id: string): Promise<void> {
    const current = await requireLetter(couple, id);
    if (current.authorId.toString() !== userId) throw notAuthor();
    if (current.openedAt) throw opened409();
    const deleted = await letterRepository.softDelete(couple._id, current._id, new Types.ObjectId(userId));
    if (!deleted) {
      const again = await letterRepository.findById(couple._id, id);
      throw again?.openedAt ? opened409() : notFound();
    }
    await realtimeAudience.couple(couple._id, ['letters']);
    logger.warn('Letter deleted (soft)', { coupleId: couple._id.toString(), userId, letterId: id });
  },

  /**
   * Recipient only, once the open time has come. Idempotent: the first call writes openedAt (atomic), later calls return
   * the same letter with the same openedAt.
   */
  async open(couple: CoupleDoc, userId: string, id: string): Promise<LetterView> {
    const [letter, names] = await Promise.all([requireLetter(couple, id), memberNames(couple)]);
    if (letter.authorId.toString() === userId) throw Errors.forbidden('Chỉ người nhận mới mở được thư này');
    const now = new Date();
    const today = todayOf(couple);
    if (letter.openAt.getTime() > now.getTime()) throw sealed(toSummary(letter, userId, names, now, today));

    let doc: CoupleLetterDoc | null = letter;
    if (!letter.openedAt) {
      doc = await letterRepository.markOpened(couple._id, letter._id, new Types.ObjectId(userId), now);
      if (doc) {
        await realtimeAudience.couple(couple._id, ['letters']);
        logger.info('Letter opened', { coupleId: couple._id.toString(), userId, letterId: id });
        await notificationService.emit({
          space: 'couple', coupleId: couple._id,
          eventKey: String(letter._id), target: { kind: 'letter', id: String(letter._id) },
          to: letter.authorId,
          actorId: new Types.ObjectId(userId),
          type: 'letter_opened',
          entityId: letter._id,
          push: { body: (name) => `${name} đã mở thư của bạn 💌`, url: `/letters/${id}`, tag: `letter:${id}` },
        });
      } else {
        // Another request opened it first, the author moved the date, or deleted it a moment ago.
        doc = await letterRepository.findById(couple._id, id);
        if (!doc) throw notFound();
        if (!doc.openedAt) throw sealed(toSummary(doc, userId, names, now, today));
      }
    }
    return toView(doc, userId, names, now, today);
  },

  /** Home card (GET /api/couple/pulse): two indexed queries on { coupleId, recipientId, openAt }. */
  async pulse(couple: CoupleDoc, userId: string): Promise<PulseLetters> {
    const uid = new Types.ObjectId(userId);
    const now = new Date();
    const [ids, nextOpenOn] = await Promise.all([
      letterRepository.openableIds(couple._id, uid, now),
      letterRepository.nextSealedOpenOn(couple._id, uid, now),
    ]);
    return { openable: ids.length, openableId: ids[0]?.toString() ?? null, nextOpenOn };
  },
};
