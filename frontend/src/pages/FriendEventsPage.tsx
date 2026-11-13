import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { friendEventsApi, friendEventsKey } from '../features/friends/api';
import { FriendEventSheet } from '../features/friends/FriendEventSheet';
import { EventCard } from '../features/friends/FriendEventStrip';
import { useGoBack } from '../features/friends/useGoBack';

type Scope = 'upcoming' | 'past';

/** /friends/events — "Kèo": upcoming (soonest first, cancelled ones marked) and past events I created or was invited to. */
export function FriendEventsPage() {
  const navigate = useNavigate();
  const goBack = useGoBack('/friends');
  const [scope, setScope] = useState<Scope>('upcoming');
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: friendEventsKey(scope),
    queryFn: () => friendEventsApi.list(scope),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const items = list.data?.items ?? [];

  return (
    <Page title="Kèo" subtitle="Hẹn đi chơi với bạn bè" onBack={goBack}>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setCreating(true)}>
        <Icon name="plus" size={20} /> Lên kèo
      </button>
      <SegmentedControl
        mode="group"
        ariaLabel="Kèo"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'upcoming', label: 'Sắp tới' },
          { value: 'past', label: 'Đã qua' },
        ]}
      />
      {list.isLoading && <Skeleton height={112} count={3} />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
      {list.isSuccess && items.length === 0 && (
        <div className="card">
          <EmptyState
            art={scope === 'upcoming' ? '🗓️' : '📸'}
            title={scope === 'upcoming' ? 'Chưa có kèo nào sắp tới' : 'Chưa có kèo nào đã qua'}
            hint={scope === 'upcoming' ? 'Lên kèo rồi mời bạn bè. Kèo bạn được mời cũng hiện ở đây.' : 'Kèo xong sẽ nằm ở đây để bạn đăng ảnh buổi đó.'}
          />
        </div>
      )}
      {items.length > 0 && (
        <ul className="fev-list" aria-label={scope === 'upcoming' ? 'Kèo sắp tới' : 'Kèo đã qua'}>
          {items.map((ev) => (
            <li key={ev.id}>
              <EventCard ev={ev} wide />
            </li>
          ))}
        </ul>
      )}
      <FriendEventSheet open={creating} editing={null} onClose={() => setCreating(false)} onSaved={(ev) => navigate(`/friends/events/${ev.id}`)} />
    </Page>
  );
}
