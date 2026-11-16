export type OutingPhase = 'collecting' | 'review' | 'settling' | 'completed';
// Pending/declined are preserved for historical invitations; new members are accepted with null consent.
export type Membership = 'pending' | 'accepted' | 'declined';
export interface OutingCommon {
  access: 'invited' | 'declined' | 'full' | 'restricted';
  id: string; title: string; outingDate: string; creatorId: string;
  myMembership: Membership; revision: number; financeRevision: number;
  phase: OutingPhase; createdAt: string;
}
export interface Participant { userId: string; displayName: string; status: Membership; consent: { status: 'approved' | 'objected'; financeRevision: number } | null }
export interface Allocation { userId: string; amount: number }
export interface OutingExpense { id: string; payerId: string; title: string | null; amount: number; splitMode: 'equal' | 'custom'; participantIds: string[]; allocations: Allocation[]; status: 'active' | 'void'; createdAt: string; updatedAt: string }
export interface CapacityCount { used: number; max: number }
export interface OutingCapacity {
  participants: CapacityCount; expenses: CapacityCount; settlements: CapacityCount;
  edits: CapacityCount; ordinaryOperations: CapacityCount; reservedOperations: CapacityCount;
  editsFrozen: boolean; finalSettlementSlots: boolean;
}
export interface Settlement { id: string; fromUserId: string; toUserId: string; amount: number; status: 'pending' | 'confirmed' | 'rejected' | 'cancelled'; createdAt: string; resolvedAt: string | null }
export interface Balance { userId: string; paid: number; share: number; sent: number; received: number; balance: number; reservedOutgoing: number; reservedIncoming: number }
export interface OutingLedger extends OutingCommon {
  access: 'full' | 'restricted'; participants: Participant[]; expenses: OutingExpense[];
  settlements: Settlement[]; balances: Balance[]; suggestions: { fromUserId: string; toUserId: string; amount: number }[];
  totalExpenses: number; eventId: string | null;
  capacity: OutingCapacity;
}
export type OutingView = OutingCommon | OutingLedger;
export interface OutingSummary extends OutingCommon { memberCount?: number; totalExpenses?: number }
export interface MutationMeta { operationId: string; expectedRevision: number }
export interface OutingResult { outing: OutingView; outcome: { operationId: string; kind: string; resultId: string; committedRevision: number; replayed: boolean } }
export interface CreateOuting { title: string; outingDate: string; inviteeIds: string[]; eventId?: string }
export type ExpenseInput = { title?: string; amount: number } & ({ splitMode: 'equal'; participantIds: string[] } | { splitMode: 'custom'; allocations: Allocation[] });
export const isLedger = (view: OutingView): view is OutingLedger => view.access === 'full' || view.access === 'restricted';
