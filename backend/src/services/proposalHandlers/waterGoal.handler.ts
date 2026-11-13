import { z } from 'zod';
import type { ProposalHandler } from '../proposal.service.js';
import { coupleSettingsRepository } from '../../repositories/coupleSettings.repository.js';

export const waterGoalPayloadSchema = z.object({
  goalMl: z.number().int('Phải là số nguyên').min(250, 'Tối thiểu 250 ml').max(6000, 'Tối đa 6000 ml'),
});

const numberVi = new Intl.NumberFormat('vi-VN');

export const waterGoalHandler: ProposalHandler = {
  kind: 'water_goal',
  schema: waterGoalPayloadSchema,
  async apply(couple, payload) {
    const { goalMl } = waterGoalPayloadSchema.parse(payload);
    await coupleSettingsRepository.setWaterGoal(couple._id, goalMl);
  },
  summary(payload) {
    return `mục tiêu nước thành ${numberVi.format(waterGoalPayloadSchema.parse(payload).goalMl)} ml mỗi ngày`;
  },
};
