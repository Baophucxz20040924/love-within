import { Schema, model, type Document, type Types } from 'mongoose';

/** Spending groups the AI assigns to outgoing-transaction notes (from plan/PROJECT_SUMMARY.md). */
export const SPEND_CATEGORIES = ['food', 'transport', 'shopping', 'bills', 'fun', 'health', 'gift', 'travel', 'home', 'other'] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export const SPEND_CATEGORY_LABELS: Record<SpendCategory | 'unnoted', string> = {
  food: 'Ăn uống',
  transport: 'Đi lại',
  shopping: 'Mua sắm',
  bills: 'Hóa đơn',
  fun: 'Giải trí',
  health: 'Sức khỏe',
  gift: 'Quà tặng',
  travel: 'Du lịch',
  home: 'Nhà cửa',
  other: 'Khác',
  unnoted: 'Chưa ghi chú',
};

export const ASSISTANT_ROLES = ['user', 'assistant'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

export const MAX_ASSISTANT_QUESTION = 1000;
export const MAX_ASSISTANT_REPLY = 6000;
/** Messages kept on the server per user ($push + $slice). */
export const MAX_THREAD_MESSAGES = 50;

export interface AssistantMessage {
  role: AssistantRole;
  content: string;
  createdAt: Date;
}

export interface InsightSuggestion {
  title: string;
  detail: string;
  estimatedSavingVnd: number | null;
}

export interface CategoryTotal {
  key: SpendCategory | 'unnoted';
  amount: number;
  count: number;
  share: number;
}

export interface AssistantInsights {
  headline: string;
  observations: string[];
  suggestions: InsightSuggestion[];
  noteTip: string | null;
  /** Computed by the server from `noteLabels`, never by the model. */
  categories: CategoryTotal[];
  /** Normalized note → category. An array, because notes may contain "." or "$" (invalid Mongo keys). */
  noteLabels: Array<{ note: string; category: SpendCategory }>;
  /** Identifies the data the insights were built from (see assistantContext.service). */
  fingerprint: string;
  generatedAt: Date;
  model: string;
}

/**
 * One finance-assistant conversation per user (plan/PROJECT_SUMMARY.md).
 * Scoped by userId like bank data: the assistant only ever reads the owner's own cash flow.
 */
export interface AssistantThreadDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  messages: AssistantMessage[];
  /** Server-validated JSON (Mixed): written whole with $set, never patched in place. */
  insights: AssistantInsights | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<AssistantMessage>(
  {
    role: { type: String, enum: ASSISTANT_ROLES, required: true },
    content: { type: String, required: true, maxlength: MAX_ASSISTANT_REPLY },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const assistantThreadSchema = new Schema<AssistantThreadDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    messages: { type: [messageSchema], default: [] },
    insights: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false },
);

export const AssistantThread = model<AssistantThreadDoc>('AssistantThread', assistantThreadSchema);
