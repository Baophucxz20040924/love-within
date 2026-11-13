import { z } from 'zod';
import type { ProposalHandler } from '../proposal.service.js';
import { coupleRepository } from '../../repositories/couple.repository.js';
import { formatDayVi } from '../../utils/date.js';

export const anniversaryPayloadSchema = z.object({
  // ISO date "YYYY-MM-DD"; must not be in the future.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Ngày không hợp lệ')
    .refine((d) => Date.parse(`${d}T00:00:00Z`) <= Date.now(), 'Ngày không thể ở tương lai'),
});

export const anniversaryHandler: ProposalHandler = {
  kind: 'anniversary_date',
  schema: anniversaryPayloadSchema,
  async apply(couple, payload) {
    const { date } = anniversaryPayloadSchema.parse(payload);
    await coupleRepository.setAnniversaryDate(couple._id, new Date(`${date}T00:00:00Z`));
  },
  summary(payload) {
    return `ngày bắt đầu yêu thành ${formatDayVi(anniversaryPayloadSchema.parse(payload).date)}`;
  },
};
