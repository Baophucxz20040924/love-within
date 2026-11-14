import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
const require = createRequire(__filename);
require('dotenv').config = () => ({ parsed: {} });
process.env = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/never_connect', JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex') };

async function main() {
  const { realtimeAudience } = await import('../../src/services/realtimeAudience.service.js');
  const { realtimeService } = await import('../../src/services/realtime.service.js');
  const { friendshipRepository } = await import('../../src/repositories/friendship.repository.js');
  const { friendBlockRepository } = await import('../../src/repositories/friendSafety.repository.js');
  const { friendOutingRepository } = await import('../../src/repositories/friendOuting.repository.js');
  const { userRepository } = await import('../../src/repositories/user.repository.js');
  const { coupleRepository } = await import('../../src/repositories/couple.repository.js');
  const a = '111111111111111111111111', b = '222222222222222222222222', c = '333333333333333333333333', d = '444444444444444444444444';
  const id = (s: string) => new Types.ObjectId(s);
  const calls: { users: string[]; space: string; domains: string[]; access?: boolean }[] = [];
  realtimeService.publish = (users, space, domains, access) => { calls.push({ users: [...users], space, domains, access }); };
  friendshipRepository.friendIds = async () => [id(b), id(c)];
  friendBlockRepository.blockedIdsFor = async () => new Set([c]);
  await realtimeAudience.friendsOf(id(a), ['friend-posts']);
  assert.deepEqual(calls.pop()?.users, [a, b]);
  await realtimeAudience.event({ creatorId: id(a), inviteeIds: [id(b), id(c), id(d)] }, ['friend-events']);
  assert.deepEqual(calls.pop()?.users, [a, b]);
  coupleRepository.findActiveById = async () => ({ memberIds: [id(a), id(b)] } as never);
  userRepository.findById = async () => ({ coupleId: id(c) } as never);
  await realtimeAudience.coupleForUser(a, ['wallet']);
  assert.deepEqual(calls.pop()?.users, [a, b]);
  userRepository.findById = async () => ({ coupleId: null } as never);
  await realtimeAudience.coupleForUser(a, ['pairing']);
  assert.deepEqual(calls.pop()?.users, [a]);
  friendshipRepository.listBetween = async () => [{ status: 'accepted' } as never];
  friendshipRepository.areFriends = async (_a, user) => user === c;
  friendOutingRepository.groupHasBlock = async (ids) => ids.includes(d);
  const outing = { creatorId: a, participants: [
    { userId: a, status: 'accepted' }, { userId: b, status: 'accepted' },
    { userId: c, status: 'pending' }, { userId: d, status: 'declined' },
  ] } as const;
  await realtimeAudience.outing(outing, ['friend-outings']);
  assert.deepEqual(calls.pop()?.users, [a, b, c]);
  friendOutingRepository.groupHasBlock = async () => true;
  await realtimeAudience.outing(outing, ['friend-outings'], true);
  assert.deepEqual(calls.pop(), { users: [a, b], space: 'friends', domains: ['friend-outings'], access: true });
  friendshipRepository.friendIds = async () => { throw new Error('database unavailable'); };
  await assert.doesNotReject(() => realtimeAudience.friendsOf(a, ['friends']));
  realtimeService.publish = () => { throw new Error('delivery unavailable'); };
  await assert.doesNotReject(() => realtimeAudience.own(a, 'couple', ['account']));
  console.log('realtime audience tests passed');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
