import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useAuth } from '../auth/AuthContext';
import { tokenStore } from '../../lib/tokenStore';
import { ApiRequestError } from '../../lib/apiClient';
import { deniedSteps } from './PushHelp';
import { claimOnboarding, finishOnboarding, isPushExplicitlyOff, onboardingVersion, subscribeOnboarding } from './onboardingPolicy';
import { usePushReadiness } from './readiness';
import { usePushDevice, usePushSwitch } from './usePushDevice';

export function isPushOnboardingRoute(path: string, space: 'couple' | 'friends'): boolean {
  const route = path.replace(/\/+$/, '') || '/';
  if (space === 'friends') return /^\/friends(?:\/(?:people|notifications|me|me\/blocked|me\/invites|events|outings|(?:posts|events|outings|u)\/[^/]+))?$/.test(route);
  return route === '/' || /^\/(?:pairing|quests|quests\/(?:water|bucket)|water|notifications|approvals|stories|stories\/[^/]+|market|finance|finance\/(?:guide|assistant)|savings|savings\/[^/]+|questions|questions\/[^/]+|events|letters|letters\/[^/]+|moments|profile|profile\/moods)$/.test(route);
}

/** Explicit auth is an opportunity, not browser consent. Never request permission from an effect. */
export function PushOnboarding() {
  const auth = useAuth();
  const ready = usePushReadiness();
  const { pathname } = useLocation();
  const generation = tokenStore.generation();
  const eligible = ready && !!auth.completedAuth && auth.completedAuth.generation === generation
    && isPushOnboardingRoute(pathname, auth.space);
  // Do not inspect service-worker/device state behind a privacy mask.
  return eligible ? <OnboardingDevice key={generation} userId={auth.me!.user.id} generation={generation} pathname={pathname} /> : null;
}

function OnboardingDevice({ userId, generation, pathname }: { userId: string; generation: string; pathname: string }) {
  const { state, serverEnabled } = usePushDevice();
  const policyVersion = useSyncExternalStore(subscribeOnboarding, onboardingVersion, () => 0);
  const explicitlyOff = isPushExplicitlyOff(userId);
  const [shown, setShown] = useState(false);
  const mounted = useRef(true);
  const claiming = useRef(false);
  const owned = useRef(false);
  const finished = useRef(false);
  const origin = useRef(pathname);
  const latest = useRef({ state, serverEnabled, pathname });
  latest.current = { state, serverEnabled, pathname };
  const failed = useRef(false);
  const finish = (reason: 'later' | 'failure' | 'denied' | 'success' | 'interrupted' | 'unavailable') => {
    if (finished.current) return;
    finished.current = true;
    if (owned.current) finishOnboarding(userId, generation, reason === 'interrupted' && failed.current ? 'failure' : reason);
    if (mounted.current) setShown(false);
  };
  const device = usePushSwitch({ silent: true, guard: () => {
    if (finished.current || !mounted.current || latest.current.pathname !== origin.current
      || latest.current.serverEnabled !== true || isPushExplicitlyOff(userId)) {
      throw new ApiRequestError(409, 'PUSH_CHANGED', 'Cài đặt thông báo đã thay đổi.');
    }
  }, onFailure: (code) => {
    if (code === 'dismissed') finish('later');
    else if (code === 'unavailable') finish('unavailable');
    else if (code !== 'denied') failed.current = true;
  } });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode replays effects. Only a real unmount abandons the claimed presentation.
      queueMicrotask(() => { if (!mounted.current) finish('interrupted'); });
    };
  }, []);
  useEffect(() => {
    if (origin.current !== pathname || explicitlyOff) { finish('interrupted'); return; }
    if (shown && state === 'on') { finish('success'); return; }
    if (shown && (serverEnabled === false || state === 'unsupported')) { finish('unavailable'); return; }
    if (finished.current || claiming.current || shown || state === 'loading' || serverEnabled === null) return;
    if (serverEnabled !== true || state === 'on' || state === 'unsupported') { finished.current = true; return; }
    claiming.current = true;
    const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
    void claimOnboarding(userId, generation, permission).then(claimed => {
      owned.current = claimed;
      if (!claimed) { finished.current = true; return; }
      if (!mounted.current || !tokenStore.isCurrent(generation) || finished.current
        || latest.current.pathname !== origin.current || latest.current.serverEnabled !== true
        || latest.current.state === 'on' || latest.current.state === 'unsupported' || isPushExplicitlyOff(userId)) {
        finished.current = true;
        owned.current = false;
        finishOnboarding(userId, generation, 'interrupted');
        return;
      }
      setShown(true);
    }).catch(() => { finished.current = true; });
  }, [userId, generation, state, serverEnabled, shown, pathname, explicitlyOff, policyVersion]);

  if (!shown || finished.current || explicitlyOff || state === 'loading' || state === 'on') return null;
  const dismiss = () => finish(state === 'denied' ? 'denied' : failed.current ? 'failure' : 'later');
  const title = state === 'ios-install' ? 'Nhận thông báo trên iPhone' : state === 'denied' ? 'Thông báo đang bị chặn' : 'Bật thông báo trên máy này?';
  return <aside className="push-onboarding" aria-label="Thiết lập thông báo sau đăng nhập">
    <section className="card card--tint-brand push-suggest">
      <div className="push-suggest__head">
        <span className="icon-tile" aria-hidden="true"><Icon name="bell" size={20} /></span>
        <div className="push-suggest__body">
          <p className="strong">{title}</p>
          <p className="text-sm text-muted">{state === 'denied' ? deniedSteps() : state === 'ios-install'
            ? 'Thêm Love Within vào Màn hình chính, rồi mở app từ biểu tượng đó để bật thông báo (iOS/iPadOS 16.4 trở lên).'
            : 'Nhận lời nhắc và cập nhật ngay trên thiết bị, không cần mở app để kiểm tra.'}</p>
          <p className="text-sm text-muted">Áp dụng cho tài khoản trên máy này. Thông báo luôn ẩn tên người và nội dung; giờ yên lặng và lựa chọn của bạn được giữ nguyên.</p>
        </div>
        <button type="button" className="icon-btn push-suggest__close" aria-label="Để sau" onClick={dismiss} disabled={device.busy}><Icon name="x" size={20} /></button>
      </div>
      {device.error && <p className="form-feedback" role="alert">{device.error}</p>}
      {device.busy && <p className="text-sm text-muted" role="status">Đang bật thông báo…</p>}
      <div className="btn-row">
        {state === 'off' && <button type="button" className="btn btn-primary" disabled={device.busy} onClick={() => {
          // Keep this call in the original tap stack (Safari user activation).
          void device.enable().then(on => { if (on && mounted.current && tokenStore.isCurrent(generation)) finish('success'); });
        }}>{device.error ? 'Thử lại' : 'Bật thông báo'}</button>}
        {state === 'ios-install' && <Link to="/install" className="btn btn-primary" onClick={() => finish('later')}>Xem cách cài app</Link>}
        <button type="button" className="btn btn-secondary" disabled={device.busy} onClick={dismiss}>{state === 'denied' ? 'Đã hiểu' : 'Để sau'}</button>
      </div>
    </section>
  </aside>;
}
