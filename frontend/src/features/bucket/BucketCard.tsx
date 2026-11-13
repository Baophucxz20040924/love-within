import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { ProgressBar } from '../../components/ProgressBar';
import { bucketApi, bucketListKey } from './api';

/** Quests tab: "Bucket list · 3/12 đã làm" → /quests/bucket (CP3, no new tab). Shares the "Chưa làm" list query with the page. */
export function BucketCard() {
  const list = useQuery({ queryKey: bucketListKey('todo'), queryFn: () => bucketApi.list('todo') });
  const counts = list.data?.counts;
  const total = counts ? counts.todo + counts.done : 0;
  const next = list.data?.items[0];

  return (
    <Link to="/quests/bucket" className="card card--link quest-card bk-card" aria-label="Mở bucket list">
      <div className="quest-card__head">
        <span className="icon-tile" aria-hidden="true">
          🪣
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="card__title">
            Bucket list
            {counts && total > 0 && (
              <span className="text-muted bk-card__count">
                {' · '}
                {counts.done}/{total} đã làm
              </span>
            )}
          </h3>
          <p className="text-sm text-muted bk-card__hint">
            {list.isError
              ? 'Chạm để mở danh sách'
              : !counts
                ? 'Đang tải…'
                : total === 0
                  ? 'Những điều muốn cùng nhau làm. Thêm mục đầu tiên nhé!'
                  : next
                    ? `Tiếp theo: ${next.emoji} ${next.title}`
                    : 'Đã làm hết danh sách 🎉'}
          </p>
        </div>
        <Icon name="chevronRight" className="text-muted" />
      </div>
      {counts && total > 0 && <ProgressBar value={(counts.done / total) * 100} tone="success" label="Bucket list đã làm" />}
    </Link>
  );
}
