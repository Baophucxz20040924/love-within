import type { Types } from 'mongoose';
import { getStorage } from '../integrations/index.js';
import { userRepository } from '../repositories/user.repository.js';

/** How a person appears to others: name and photo. Never includes the email. */
export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

const UNKNOWN_NAME = 'Người dùng';

/** Presigned, browser-cacheable URL of a profile photo (the same URL for about an hour), or null. */
export async function avatarUrlOf(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  return (await getStorage().getDownloadUrl(key, { cacheable: true })).url;
}

/** The loaded profile for `id`, or a placeholder for an account that no longer exists. */
export function profileOf(profiles: Map<string, PublicProfile>, id: Types.ObjectId | string): PublicProfile {
  const key = id.toString();
  return profiles.get(key) ?? { id: key, displayName: UNKNOWN_NAME, avatarUrl: null };
}

export const profileService = {
  /** Name + photo for several users with one query. Signing photo URLs is local (no network call). */
  async load(ids: Types.ObjectId[], options?: { skipMissing?: boolean }): Promise<Map<string, PublicProfile>> {
    const unique = [...new Map(ids.map((id) => [id.toString(), id])).values()];
    const rows = await userRepository.findProfiles(unique);
    const included = options?.skipMissing ? unique.filter((id) => rows.has(id.toString())) : unique;
    const entries = await Promise.all(
      included.map(async (id): Promise<[string, PublicProfile]> => {
        const key = id.toString();
        const row = rows.get(key);
        return [key, { id: key, displayName: row?.displayName ?? UNKNOWN_NAME, avatarUrl: await avatarUrlOf(row?.avatarKey) }];
      }),
    );
    return new Map(entries);
  },

  /** Profile of a user document already in hand. */
  async of(user: { _id: Types.ObjectId; displayName: string; avatarKey?: string | null }): Promise<PublicProfile> {
    return { id: user._id.toString(), displayName: user.displayName, avatarUrl: await avatarUrlOf(user.avatarKey) };
  },
};
