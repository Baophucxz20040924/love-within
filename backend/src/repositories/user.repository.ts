import { Types } from 'mongoose';
import { User, type FinanceVisibility, type PushSettings, type UserDoc } from '../models/User.js';

/** Missing pre-migration version is exactly zero, never a wildcard after a rotation. */
function versionFilter(expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid credential version');
  }
  return expected === 0
    ? { $or: [{ credentialVersion: 0 }, { credentialVersion: { $exists: false } }] }
    : { credentialVersion: expected };
}

export const userRepository = {
  findCredentialsById(id: string | Types.ObjectId) {
    return User.findById(id)
      .select('_id email passwordHash role credentialVersion mustChangePassword temporaryPasswordExpiresAt')
      .lean<Pick<UserDoc, '_id' | 'email' | 'passwordHash' | 'role' | 'credentialVersion' | 'mustChangePassword' | 'temporaryPasswordExpiresAt'>>()
      .exec();
  },

  /** Atomic compare-and-swap: two administrators cannot silently reset the same observed version. */
  resetPassword(id: string, expectedVersion: number, passwordHash: string, expiresAt: Date): Promise<UserDoc | null> {
    return User.findOneAndUpdate({
      _id: id,
      email: { $ne: 'admin@phucxz.com' },
      $and: [versionFilter(expectedVersion), { $or: [{ role: 'user' }, { role: { $exists: false } }] }],
    }, {
      $set: { passwordHash, credentialVersion: expectedVersion + 1, mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt },
    }, { new: true, runValidators: true }).exec();
  },

  completePasswordChange(id: string, expectedVersion: number, temporaryExpiresAt: Date, passwordHash: string, grantExpiresAt: Date): Promise<UserDoc | null> {
    return User.findOneAndUpdate({
      _id: id,
      email: { $ne: 'admin@phucxz.com' },
      mustChangePassword: true,
      temporaryPasswordExpiresAt: temporaryExpiresAt,
      // Checked on the database at commit time too, not only before slow bcrypt work.
      $expr: { $and: [
        { $gt: ['$temporaryPasswordExpiresAt', '$$NOW'] },
        { $gt: [{ $literal: grantExpiresAt }, '$$NOW'] },
      ] },
      $and: [versionFilter(expectedVersion), { $or: [{ role: 'user' }, { role: { $exists: false } }] }],
    }, {
      $set: { passwordHash, credentialVersion: expectedVersion + 1, mustChangePassword: false, temporaryPasswordExpiresAt: null },
    }, { new: true, runValidators: true }).exec();
  },

  changeAdminPassword(id: string, expectedVersion: number, passwordHash: string): Promise<UserDoc | null> {
    return User.findOneAndUpdate({
      _id: id, role: 'admin', email: 'admin@phucxz.com',
      mustChangePassword: { $ne: true }, temporaryPasswordExpiresAt: null,
      ...versionFilter(expectedVersion),
    }, {
      $set: { passwordHash, credentialVersion: expectedVersion + 1 },
    }, { new: true, runValidators: true }).exec();
  },
  findById(id: string | Types.ObjectId): Promise<UserDoc | null> {
    return User.findById(id).exec();
  },

  findByEmail(email: string): Promise<UserDoc | null> {
    return User.findOne({ email: email.toLowerCase().trim() }).exec();
  },

  findRecoveryByEmail(email: string) {
    return User.findOne({ email: email.toLowerCase().trim() })
      .select('_id displayName email role credentialVersion mustChangePassword temporaryPasswordExpiresAt')
      .lean<Pick<UserDoc, '_id' | 'displayName' | 'email' | 'role' | 'credentialVersion' | 'mustChangePassword' | 'temporaryPasswordExpiresAt'>>()
      .exec();
  },

  /** id → displayName for a few users in one query (no password hash or other fields loaded). */
  async findDisplayNames(ids: Types.ObjectId[]): Promise<Map<string, string>> {
    const users = await User.find({ _id: { $in: ids } }).select('displayName').lean().exec();
    return new Map(users.map((u) => [u._id.toString(), u.displayName]));
  },

  create(input: {
    email: string;
    passwordHash: string;
    displayName: string;
    timezone?: string;
  }): Promise<UserDoc> {
    return User.create(input);
  },

  async setCoupleId(userId: Types.ObjectId, coupleId: Types.ObjectId | null): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { coupleId } }).exec();
  },

  async setStoriesSeenAt(userId: string | Types.ObjectId, at: Date): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { storiesSeenAt: at } }).exec();
  },

  async setMarketSeenAt(userId: string | Types.ObjectId, at: Date): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { marketSeenAt: at } }).exec();
  },

  async setFinanceVisibility(userId: string | Types.ObjectId, visibility: FinanceVisibility): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { financeVisibility: visibility } }).exec();
  },

  async setAiFinanceConsent(userId: string | Types.ObjectId, at: Date | null): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { aiFinanceConsentAt: at } }).exec();
  },

  // ── Hidden friends space ──

  async setFriendsMember(userId: Types.ObjectId, joinedAt: Date, searchName: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { friendsJoinedAt: joinedAt, friendsSearchName: searchName } }).exec();
  },

  /**
   * Friends-space members only (users who never entered it stay invisible), never one of `excludeIds`
   * (the caller and people blocked either way). Name, photo key and id only: never email.
   */
  searchFriendsMembers(
    match: { email: string } | { namePattern: string },
    excludeIds: Types.ObjectId[],
    limit: number,
  ): Promise<{ _id: Types.ObjectId; displayName: string; avatarKey: string | null }[]> {
    const filter: Record<string, unknown> = { friendsJoinedAt: { $ne: null }, _id: { $nin: excludeIds } };
    if ('email' in match) filter.email = match.email.toLowerCase().trim();
    else filter.friendsSearchName = { $regex: match.namePattern };
    return User.find(filter)
      .select('displayName avatarKey')
      .collation({ locale: 'vi' })
      .sort({ displayName: 1 })
      .limit(limit)
      .lean<{ _id: Types.ObjectId; displayName: string; avatarKey: string | null }[]>()
      .exec();
  },

  async isFriendsMember(id: string | Types.ObjectId): Promise<boolean> {
    return (await User.exists({ _id: id, friendsJoinedAt: { $ne: null } }).exec()) !== null;
  },

  /**
   * "@" picker in comments (BB8): members among `ids` whose search name contains `namePattern` (escaped, no diacritics;
   * empty = everyone), A→Z. Name, photo key and id only.
   */
  findMembersByName(
    ids: Types.ObjectId[],
    namePattern: string,
    limit: number,
  ): Promise<{ _id: Types.ObjectId; displayName: string; avatarKey: string | null }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const filter: Record<string, unknown> = { _id: { $in: ids }, friendsJoinedAt: { $ne: null } };
    if (namePattern) filter.friendsSearchName = { $regex: namePattern };
    return User.find(filter)
      .select('displayName avatarKey')
      .collation({ locale: 'vi' })
      .sort({ displayName: 1 })
      .limit(limit)
      .lean<{ _id: Types.ObjectId; displayName: string; avatarKey: string | null }[]>()
      .exec();
  },

  /** id → name + photo key for several users in one query (no email, no password hash). */
  async findProfiles(ids: Types.ObjectId[]): Promise<Map<string, { displayName: string; avatarKey: string | null }>> {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
      .select('displayName avatarKey')
      .lean<{ _id: Types.ObjectId; displayName: string; avatarKey?: string | null }[]>()
      .exec();
    return new Map(users.map((u) => [u._id.toString(), { displayName: u.displayName, avatarKey: u.avatarKey ?? null }]));
  },

  async setAvatarKey(userId: Types.ObjectId, key: string | null): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { avatarKey: key } }).exec();
  },

  async setFriendsBio(userId: Types.ObjectId, bio: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { friendsBio: bio } }).exec();
  },

  async setFriendsNotifSeenAt(userId: Types.ObjectId, at: Date): Promise<void> {
    await User.updateOne({ _id: userId }, { $set: { friendsNotifSeenAt: at } }).exec();
  },

  // ── Web Push (N4) ──

  /** Push switches and timezone only (no email, no password hash). Raw: older accounts may miss fields. */
  findPushProfile(id: Types.ObjectId | string): Promise<{ pushSettings?: Partial<PushSettings>; timezone?: string } | null> {
    return User.findById(id).select('pushSettings timezone').lean<{ pushSettings?: Partial<PushSettings>; timezone?: string }>().exec();
  },

  /** `fields`: dotted paths under pushSettings, e.g. { 'couple.stories': false, 'quiet.from': '22:00' }. */
  async setPushSettings(id: Types.ObjectId | string, fields: Record<string, boolean | string>): Promise<void> {
    const $set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`pushSettings.${k}`, v]));
    if (Object.keys($set).length > 0) await User.updateOne({ _id: id }, { $set }).exec();
  },
};
