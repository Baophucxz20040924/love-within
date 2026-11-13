/**
 * Which part of the app this session belongs to. 'friends' is the hidden "Hội bạn bè" space, entered
 * only through the secret login (tap the heart 4 times on /login, then "Đăng nhập"). Same account
 * and tokens as the couple app; this only decides which screens the router shows.
 */
export type Space = 'couple' | 'friends';

const KEY = 'lw.space';

export const spaceStore = {
  get(): Space {
    try {
      return localStorage.getItem(KEY) === 'friends' ? 'friends' : 'couple';
    } catch {
      return 'couple';
    }
  },
  set(space: Space): void {
    try {
      if (space === 'friends') localStorage.setItem(KEY, space);
      else localStorage.removeItem(KEY);
    } catch {
      // Storage disabled: the space lasts until the page reloads.
    }
  },
  isSpaceKey(key: string): boolean {
    return key === KEY;
  },
};

/** Home route of each space. */
export function homeOf(space: Space): string {
  return space === 'friends' ? '/friends' : '/';
}
