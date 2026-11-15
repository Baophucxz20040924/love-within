import { Types } from 'mongoose';
import type { CoupleDoc } from '../models/Couple.js';
import { BucketItem, type BucketItemDoc } from '../models/BucketItem.js';
import { storyRepository, storyCreationFingerprint } from '../repositories/story.repository.js';
import { Errors } from '../utils/errors.js';

/** Resume exactly the completion persisted by markDone, never a historical done flag. */
export async function finishBucketCompletion(couple: CoupleDoc, item: BucketItemDoc): Promise<boolean> {
  const completion = item.completion;
  if (!completion || completion.ready) return true;
  const saved = completion.story;
  if (!saved) throw Errors.internal('Thiếu dữ liệu hoàn tất bucket');
  const authorId = new Types.ObjectId(saved.actorUserId);
  const content = { coupleId: couple._id, authorId, body: saved.body, mood: null, happenedOn: saved.happenedOn, photos: saved.photos, videos: [] };
  let existing = await storyRepository.findReserved(couple._id, saved.id, authorId);
  if (existing && existing.creationFingerprint !== storyCreationFingerprint(content)) throw Errors.conflict('Dữ liệu kỷ niệm không khớp lần hoàn tất');
  if (!existing) {
    // Lazy import keeps wallet recovery free of media/providers unless a real story remains unfinished.
    const { storyService } = await import('./story.service.js');
    await storyService.create(couple, saved.actorUserId, content, { notify: false, reservedId: new Types.ObjectId(saved.id) });
    existing = await storyRepository.findReserved(couple._id, saved.id, authorId);
    if (!existing || existing.creationFingerprint !== storyCreationFingerprint(content)) throw Errors.internal('Chưa xác nhận kỷ niệm');
  }
  const updated = await BucketItem.findOneAndUpdate({ _id: item._id, coupleId: couple._id, doneAt: item.doneAt,
    'completion.story.id': saved.id, 'completion.ready': false,
  }, { $set: { 'completion.ready': true, storyId: existing._id } }, { new: true }).exec();
  if (!updated) {
    const current = await BucketItem.findOne({ _id: item._id, coupleId: couple._id, doneAt: item.doneAt, 'completion.story.id': saved.id, 'completion.ready': true }).exec();
    if (!current) return false;
  }
  completion.ready = true;
  item.storyId = existing._id;
  return true;
}
