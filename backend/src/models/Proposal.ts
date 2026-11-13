import { Schema, model, type Document, type Types } from 'mongoose';

export type ProposalKind = 'water_goal' | 'anniversary_date' | 'savings_goal' | 'savings_goal_update';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ProposalDoc extends Document {
  _id: Types.ObjectId;
  coupleId: Types.ObjectId;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  createdBy: Types.ObjectId;
  approvals: Types.ObjectId[];
  status: ProposalStatus;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const proposalSchema = new Schema<ProposalDoc>(
  {
    coupleId: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    kind: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvals: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

proposalSchema.index({ coupleId: 1, status: 1 });
// Separate partial indexes keep legacy proposal data/behavior untouched.
for (const kind of ['savings_goal', 'savings_goal_update']) {
  proposalSchema.index({ coupleId: 1, kind: 1 }, {
    name: `pending_${kind}`, unique: true,
    partialFilterExpression: { status: 'pending', kind },
  });
}

export const Proposal = model<ProposalDoc>('Proposal', proposalSchema);
