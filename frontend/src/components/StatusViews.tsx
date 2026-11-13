import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { ApprovalsBell } from './ApprovalsBell';

interface PageProps {
  title: string;
  subtitle?: string;
  /** Sub-pages get a back link instead of the bell. */
  back?: string;
  /** Back button that runs code instead of a fixed link (e.g. go to the previous page). */
  onBack?: () => void;
  actions?: ReactNode;
  /** Couple approvals bell (default on). Off in the friends space, which has no couple. */
  bell?: boolean;
  children: ReactNode;
  /** Wider canvases are opt-in; reading and form pages stay comfortably bounded. */
  width?: 'reading' | 'wide';
  className?: string;
}

/** Standard page: sticky header (title, subtitle, actions, bell or back) + content stack. */
export function Page({ title, subtitle, back, onBack, actions, bell = true, children, width = 'reading', className = '' }: PageProps) {
  const hasBack = Boolean(back || onBack);
  return (
    <section className={`page page--${width} ${className}`.trim()}>
      <header className={`page-header${hasBack ? ' page-header--sub' : ''}`}>
        {onBack ? (
          <button type="button" className="icon-btn page-header__back" aria-label="Quay lại" onClick={onBack}>
            <Icon name="chevronLeft" size={26} />
          </button>
        ) : (
          back && (
            <Link to={back} className="icon-btn page-header__back" aria-label="Quay lại">
              <Icon name="chevronLeft" size={26} />
            </Link>
          )
        )}
        <div className="page-header__titles">
          <h1 className="page-header__title">{title}</h1>
          {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
        </div>
        <div className="page-header__actions">
          {actions}
          {!hasBack && bell && <ApprovalsBell />}
        </div>
      </header>
      {children}
    </section>
  );
}

/** Content-shaped placeholders: feel faster than a spinner and avoid layout jumps. */
export function Skeleton({ height = 96, count = 1 }: { height?: number; count?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Đang tải">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function Loading({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner spinner--lg" aria-hidden="true" />
      <p className="state__hint">{label}</p>
    </div>
  );
}

export function EmptyState({ art = '🌱', title, hint, action }: { art?: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="state__art" aria-hidden="true">
        {art}
      </div>
      <p className="state__title">{title}</p>
      {hint && <p className="state__hint">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Không tải được dữ liệu',
  message = 'Kiểm tra kết nối mạng rồi thử lại.',
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state" role="alert">
      <div className="icon-tile icon-tile--warning" aria-hidden="true">
        <Icon name="alert" />
      </div>
      <p className="state__title">{title}</p>
      <p className="state__hint">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-outline" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}
