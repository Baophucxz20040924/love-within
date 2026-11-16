import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '../../components/Icon';
import { ErrorState, Skeleton } from '../../components/StatusViews';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../../lib/apiClient';
import type { PushSettings, PushSettingsPatch, PushSpace } from '../../lib/types';
import { pushApi, pushSettingsKey } from './api';
import { currentEndpoint, disableOnThisDevice } from './device';
import { PushDeviceHelp } from './PushHelp';
import { usePushDevice, usePushSwitch } from './usePushDevice';

/** One settings group of a space (users.pushSettings.<space>.<key>). Each page lists only its own space's groups. */
export interface PushGroupRow {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
}

interface Props {
  space: PushSpace;
  groups: PushGroupRow[];
  /** What still works during quiet hours, in this space's words. */
  quietHint: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Không lưu được, thử lại nhé.');

function merge(s: PushSettings, patch: PushSettingsPatch): PushSettings {
  return {
    ...s,
    groups: { ...s.groups, ...(patch.groups ?? {}) },
    preview: patch.preview ?? s.preview,
    quiet: { ...s.quiet, ...(patch.quiet ?? {}) },
  };
}

const DEVICE_META: Record<string, string> = {
  loading: 'Đang kiểm tra…',
  on: 'Đang bật trên máy này',
  off: 'Đang tắt trên máy này',
  denied: 'Đang bị chặn trong cài đặt',
  'ios-install': 'Cần cài app lên Màn hình chính',
  unsupported: 'Trình duyệt này chưa hỗ trợ',
};

/** Account-wide device switch, fixed notification privacy, and this space's groups / quiet hours. */
export function PushSettingsPanel({ space, groups, quietHint }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const key = pushSettingsKey(space);
  const settings = useQuery({ queryKey: key, queryFn: () => pushApi.settings(space) });
  const { state, serverEnabled } = usePushDevice();
  const device = usePushSwitch();

  const update = useMutation({
    mutationFn: (patch: PushSettingsPatch) => pushApi.updateSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<PushSettings>(key);
      if (before) qc.setQueryData<PushSettings>(key, merge(before, patch));
      return { before };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      toast.error(errorText(err));
    },
    onSuccess: (s) => qc.setQueryData(key, s),
  });

  const test = useMutation({
    mutationFn: async () => {
      const endpoint = await currentEndpoint();
      if (!endpoint) throw new ApiRequestError(404, 'PUSH_NOT_SUBSCRIBED', 'Máy này chưa bật thông báo');
      return pushApi.test(endpoint);
    },
    onSuccess: () => toast.success('Đã gửi. Thông báo thử sẽ hiện trên máy này sau vài giây.'),
    onError: (err) => {
      // The server no longer has this device: switch it off here too, so it can be turned on again.
      if (err instanceof ApiRequestError && (err.code === 'PUSH_GONE' || err.code === 'PUSH_NOT_SUBSCRIBED')) void disableOnThisDevice().catch(() => undefined);
      toast.error(errorText(err));
    },
  });

  // Quiet hours: edited locally, saved when a full time is picked.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const quiet = settings.data?.quiet;
  const savedFrom = quiet?.from;
  const savedTo = quiet?.to;
  useEffect(() => {
    if (savedFrom) setFrom(savedFrom);
    if (savedTo) setTo(savedTo);
  }, [savedFrom, savedTo]);

  function saveTime(which: 'from' | 'to', value: string) {
    if (which === 'from') setFrom(value);
    else setTo(value);
    if (!HHMM.test(value) || !quiet || quiet[which] === value) return;
    const other = which === 'from' ? to : from;
    if (other === value) {
      toast.error('Giờ bắt đầu và giờ kết thúc phải khác nhau');
      return;
    }
    update.mutate({ space, quiet: { [which]: value } });
  }

  const usable = serverEnabled === true && (state === 'on' || state === 'off');
  const s = settings.data;
  const tz = me?.user.timezone;
  const tzLabel = !tz || tz === 'Asia/Ho_Chi_Minh' ? 'giờ Việt Nam' : tz;

  return (
    <>
      <div className="section">
        <h2 className="section__title">Trên máy này</h2>
        <div className="list">
          <label className="list__item">
            <span className={`icon-tile${state === 'on' ? '' : ' icon-tile--neutral'}`} aria-hidden="true">
              <Icon name={state === 'on' ? 'bell' : 'bellOff'} size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Nhận thông báo trên máy này</span>
              <span className="list__meta" style={{ display: 'block' }}>
                {serverEnabled === false ? 'Máy chủ chưa bật thông báo' : DEVICE_META[state]}
              </span>
            </span>
            {device.busy && <span className="spinner" aria-hidden="true" />}
            <Switch
              checked={state === 'on'}
              disabled={!usable || device.busy}
              onChange={(on) => void (on ? device.enable() : device.disable())}
            />
          </label>
          {state === 'on' && serverEnabled === true && (
            <button type="button" className="list__item" disabled={test.isPending} onClick={() => test.mutate()}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="send" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Gửi thử</span>
                <span className="list__meta" style={{ display: 'block' }}>
                  Gửi một thông báo tới máy này
                </span>
              </span>
              {test.isPending && <span className="spinner" aria-label="Đang gửi" />}
            </button>
          )}
        </div>
        <p className="text-sm text-muted">Bật hoặc tắt cho tài khoản đang đăng nhập trên máy này, không đổi khi chuyển không gian. Không ảnh hưởng các máy khác.</p>
        <PushDeviceHelp state={state} serverEnabled={serverEnabled} />
      </div>

      {settings.isLoading && <Skeleton height={56} count={3} />}
      {settings.isError && <ErrorState onRetry={() => void settings.refetch()} />}
      {s && (
        <>
          <div className="section">
            <h2 className="section__title">Loại thông báo</h2>
            <div className="list">
              {groups.map((g) => (
                <label key={g.key} className="list__item">
                  <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                    <Icon name={g.icon} size={20} />
                  </span>
                  <span className="list__body">
                    <span className="list__label">{g.label}</span>
                    <span className="list__meta" style={{ display: 'block' }}>
                      {g.hint}
                    </span>
                  </span>
                  <Switch checked={s.groups[g.key] !== false} onChange={(on) => update.mutate({ space, groups: { [g.key]: on } })} />
                </label>
              ))}
            </div>
            <p className="text-sm text-muted">Các loại thông báo này chỉ áp dụng cho không gian hiện tại, trên mọi máy bạn đã bật thông báo.</p>
          </div>

          <div className="section">
            <h2 className="section__title">Màn hình khóa</h2>
            <p className="callout push-preview">
              <Icon name="lock" size={16} />
              <span>Thông báo luôn chỉ hiện “Love Within · Bạn có một thông báo mới”, không hiện tên người, nội dung hay không gian. Chạm để mở app; mã PIN vẫn được yêu cầu nếu bạn đã bật khóa cho không gian đó.</span>
            </p>
          </div>

          <div className="section">
            <h2 className="section__title">Giờ yên lặng</h2>
            <div className="list">
              <label className="list__item">
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="moon" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Không báo vào giờ nghỉ</span>
                  <span className="list__meta" style={{ display: 'block' }}>
                    {s.quiet.enabled ? `Từ ${s.quiet.from} đến ${s.quiet.to} (${tzLabel})` : 'Đang tắt'}
                  </span>
                </span>
                <Switch checked={s.quiet.enabled} onChange={(on) => update.mutate({ space, quiet: { enabled: on } })} />
              </label>
              {s.quiet.enabled && (
                <div className="list__item quiet-hours">
                  <label className="field quiet-hours__field">
                    <span className="field__label">Từ</span>
                    <input className="input" type="time" value={from} required onChange={(e) => saveTime('from', e.target.value)} />
                  </label>
                  <label className="field quiet-hours__field">
                    <span className="field__label">Đến</span>
                    <input className="input" type="time" value={to} required onChange={(e) => saveTime('to', e.target.value)} />
                  </label>
                </div>
              )}
            </div>
            <p className="text-sm text-muted">{quietHint}</p>
          </div>
        </>
      )}
    </>
  );
}
