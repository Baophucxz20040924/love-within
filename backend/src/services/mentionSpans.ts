import { Types } from 'mongoose';
import { MAX_MENTIONS } from '../models/FriendStoryComment.js';
import { AppError } from '../utils/errors.js';

export interface MentionSpan {
  userId: string;
  offset: number;
  length: number;
}

export const badMention = () => new AppError(400, 'BAD_MENTION', 'Nhắc tên không hợp lệ. Hãy chọn lại tên trong danh sách nhé.');

/** UTF-16 offsets in the trimmed body. Resource-specific eligibility is checked separately. */
export function checkedSpans(body: string, raw: MentionSpan[]): MentionSpan[] {
  if (raw.length > MAX_MENTIONS) throw badMention();
  const sorted = [...raw].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const m of sorted) {
    if (!Types.ObjectId.isValid(m.userId) || !Number.isInteger(m.offset) || !Number.isInteger(m.length) ||
        m.length < 2 || m.offset < end || m.offset + m.length > body.length || body[m.offset] !== '@') throw badMention();
    end = m.offset + m.length;
  }
  return sorted;
}
