import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import type { FriendUser } from '../../lib/types';
import { friendMentionableKey } from './api';
import { activeQuery, insertMention, reconcile, type DraftMention } from './mentions';

/** Who can be named in this discussion: `id` keys the cache (the post id), `fn` asks the server. */
export interface MentionSearch {
  id: string;
  fn: (q: string) => Promise<FriendUser[]>;
}

interface Props {
  /** Left out: a plain box without the "@" picker (event discussions have no mentions). */
  search?: MentionSearch;
  text: string;
  mentions: DraftMention[];
  onChange: (text: string, mentions: DraftMention[]) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  placeholder: string;
  /** Keys the picker does not use (Enter to send on desktop). */
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** After every change, e.g. to grow the box. */
  onInput?: (el: HTMLTextAreaElement) => void;
}

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Same text as the box with the mentions tinted, drawn behind the transparent box (a textarea cannot style parts of its text). */
function mirror(text: string, mentions: DraftMention[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const m of mentions) {
    if (m.start < pos) continue;
    parts.push(text.slice(pos, m.start));
    parts.push(
      <mark key={`${m.userId}-${m.start}`} className="mention-field__mark">
        {text.slice(m.start, m.start + m.length)}
      </mark>,
    );
    pos = m.start + m.length;
  }
  parts.push(text.slice(pos));
  return parts;
}

/**
 * Comment box with "@" names (BB8). Typing "@" and a few letters lists up to 10 people who can see the post (no diacritics
 * needed); choosing one inserts "@Tên", shown tinted. Editing inside a name turns it back into plain text.
 */
export function MentionField({ search, text, mentions, onChange, inputRef, placeholder, onKeyDown, onInput }: Props) {
  const listId = useId();
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [hi, setHi] = useState(0);

  const active = search ? activeQuery(text, caret, mentions) : null;
  const open = active !== null && closedAt !== active.start;
  const q = useDebounced(active?.query ?? '', 200);
  const people = useQuery({
    queryKey: friendMentionableKey(search?.id ?? '', q),
    queryFn: () => search!.fn(q),
    enabled: open && Boolean(search),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const options = open ? (people.data ?? []) : [];
  const showList = options.length > 0;

  useEffect(() => setHi(0), [q]);
  // A new "@" opens the list again after Escape.
  useEffect(() => {
    if (closedAt !== null && active?.start !== closedAt) setClosedAt(null);
  }, [active?.start, closedAt]);

  function pick(index: number) {
    const user = options[index];
    const el = inputRef.current;
    if (!user || !active || !el) return;
    const next = insertMention(text, mentions, active, caret, user);
    onChange(next.text, next.mentions);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
      onInput?.(el);
    });
  }

  function keyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (showList) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHi((i) => (i + step + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(hi);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (active) setClosedAt(active.start);
        return;
      }
    }
    onKeyDown(e);
  }

  return (
    <div className="mention-field">
      <div ref={mirrorRef} className="mention-field__mirror" aria-hidden="true">
        {mirror(text, mentions)}
        {'\u200b'}
      </div>
      <textarea
        ref={inputRef}
        className="comment-bar__input mention-field__input"
        rows={1}
        value={text}
        maxLength={2000}
        placeholder={placeholder}
        aria-label="Viết bình luận"
        aria-autocomplete={search ? 'list' : undefined}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList ? `${listId}-${hi}` : undefined}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next, reconcile(text, next, mentions));
          setCaret(e.target.selectionStart ?? next.length);
          onInput?.(e.target);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onScroll={(e) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={keyDown}
      />
      {showList && (
        <ul id={listId} className="mention-picker" role="listbox" aria-label="Nhắc tên">
          {options.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === hi}
              className={`mention-picker__item${i === hi ? ' is-active' : ''}`}
              // Keep the focus (and the phone keyboard) in the box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <Avatar name={u.displayName} src={u.avatarUrl} size={32} />
              <span className="mention-picker__name">{u.displayName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
