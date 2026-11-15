import { Avatar } from '../../components/Avatar';
import type { StoryReactor } from '../../lib/types';
import { reactionOf } from './constants';
import './ReactionPeople.css';

/** Shared presentation for the two-person Love list and the paged friends list. */
export function ReactionPeople({ people, myId }: { people: StoryReactor[]; myId?: string }) {
  return (
    <div className="reaction-people">
      {people.map((person) => {
        const reaction = reactionOf(person.type);
        return (
          <div className="reaction-person" key={person.id}>
            <Avatar name={person.displayName} src={person.avatarUrl} size={42} />
            <span className="reaction-person__name">
              {person.displayName}{person.id === myId && <span className="reaction-person__you">Bạn</span>}
            </span>
            <span className="reaction-person__reaction" aria-label={reaction.label} title={reaction.label}>
              <span aria-hidden="true">{reaction.emoji}</span>
              <span>{reaction.label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
