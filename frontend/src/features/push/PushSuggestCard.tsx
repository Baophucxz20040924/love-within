import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import type { PushSpace } from '../../lib/types';
import { deniedSteps } from './PushHelp';
import { pushSuggest, usePushSuggest } from './suggest';
import { usePushDevice, usePushSwitch } from './usePushDevice';

interface Props {
  space: PushSpace;
  /** Why turn notifications on, in this space's words (the page passes it: copy never crosses spaces). */
  text: string;
}

/**
 * Soft suggestion after a meaningful action (never at app start). Shown until dismissed or turned on; never again after
 * that on this device. iPhone outside the installed app → how to install; blocked → how to allow again.
 */
export function PushSuggestCard({ space, text }: Props) {
  const suggest = usePushSuggest(space);
  const { state, serverEnabled } = usePushDevice();
  const { busy, enable } = usePushSwitch();

  if (suggest !== 'shown' || serverEnabled !== true) return null;
  if (state !== 'off' && state !== 'ios-install' && state !== 'denied') return null;

  const dismiss = () => pushSuggest.dismiss(space);
  const title =
    state === 'ios-install' ? 'Nhận thông báo trên iPhone' : state === 'denied' ? 'Thông báo đang bị chặn' : 'Bật thông báo trên máy này?';
  const body =
    state === 'ios-install'
      ? 'Thêm Love Within vào Màn hình chính, mở app từ biểu tượng đó rồi bật thông báo (iOS 16.4 trở lên).'
      : state === 'denied'
        ? deniedSteps()
        : text;

  return (
    <section className="card card--tint-brand push-suggest" aria-label="Gợi ý bật thông báo">
      <div className="push-suggest__head">
        <span className="icon-tile" aria-hidden="true">
          <Icon name={state === 'denied' ? 'bellOff' : state === 'ios-install' ? 'smartphone' : 'bell'} size={20} />
        </span>
        <div className="push-suggest__body">
          <p className="strong">{title}</p>
          <p className="text-sm text-muted">{body}</p>
          {state === 'off' && <p className="text-sm text-muted">Áp dụng cho tài khoản trên máy này, không đổi khi chuyển không gian. Thông báo luôn ẩn tên người và nội dung.</p>}
        </div>
        <button type="button" className="icon-btn push-suggest__close" aria-label="Ẩn gợi ý này" onClick={dismiss}>
          <Icon name="x" size={20} />
        </button>
      </div>
      {state === 'off' && (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              void enable().then((on) => on && pushSuggest.dismiss(space));
            }}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            Bật thông báo
          </button>
          <button type="button" className="btn btn-secondary" onClick={dismiss}>
            Để sau
          </button>
        </div>
      )}
      {state === 'ios-install' && (
        <Link to="/install" className="btn btn-primary btn-block">
          <Icon name="smartphone" size={18} /> Xem cách cài app
        </Link>
      )}
    </section>
  );
}
