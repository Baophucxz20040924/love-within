import { useId, useState } from 'react';
import type { ScamStage, ScamState } from './types';

import { scenarioOf } from './scenarios';
export function SecretDrawer({ match, busy, onVerify }: {
  match: NonNullable<ScamState['match']>; busy: boolean; onVerify: (stage: ScamStage, value: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Partial<Record<ScamStage, string>>>({});
  const [showPassword, setShowPassword] = useState(false);
  const id = useId();
  const scenario = scenarioOf(match), stages = scenario.steps;
  const current = stages.findIndex(step => step.id === match.stage);
  return <section className={`scam-drawer${open ? ' is-open' : ''}`} aria-label="Xác nhận thông tin">
    <button type="button" className="scam-drawer__handle" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(v => !v)}>
      <span aria-hidden="true">{open ? '−' : '+'} </span>
      {open ? 'Thu gọn xác nhận' : 'Mở xác nhận thông tin'} · {match.status === 'won' ? stages.length : current}/{stages.length}
    </button>
    <div id={id} hidden={!open} className="scam-drawer__body">
      <p className="text-muted text-sm">{scenario.title} · Không nhập thông tin thật.</p>
      {stages.map((step, index) => {
        const stage = step.id;
        const done = index < current || match.status === 'won';
        const editable = match.status === 'active' && !done;
        const enabled = editable && index === current;
        const verify = async () => {
          if (busy || !enabled || !values[stage]) return;
          if (await onVerify(stage, values[stage]!)) setValues(v => ({ ...v, [stage]: '' }));
        };
        return <form key={stage} className={`scam-secret${enabled ? ' is-current' : ''}`} aria-current={enabled ? 'step' : undefined} autoComplete="off" onSubmit={e => { e.preventDefault(); void verify(); }}>
          <div className="scam-secret__heading"><label htmlFor={`${id}-${stage}`}>{step.label} {done && '✓'}</label><span>{done ? 'Đã xác nhận' : enabled ? 'Sẵn sàng xác nhận' : editable ? 'Chờ xác nhận bước trước' : 'Ván đã kết thúc'}</span></div>
          <div className="row">
            <input id={`${id}-${stage}`} name={`prop-${stage}`} type={step.inputKind === 'password' && !showPassword ? 'password' : 'text'}
              autoComplete={step.inputKind === 'password' ? 'new-password' : 'off'} inputMode={step.inputKind === 'numeric' ? 'numeric' : 'text'}
              maxLength={100} readOnly={!editable} value={values[stage] ?? ''} aria-describedby={`${id}-${stage}-format`}
              placeholder={done ? 'Đã xác nhận' : editable ? 'Có thể nhập trước' : 'Ván đã kết thúc'}
              onChange={e => setValues(v => ({ ...v, [stage]: e.target.value }))} />
            <button className="btn btn-primary" disabled={!enabled || busy || !values[stage]} type="submit">Xác nhận {step.label}</button>
          </div>
          <small id={`${id}-${stage}-format`}>{step.format} · +{step.points} điểm</small>
          {step.inputKind === 'password' && <label className="scam-password-toggle"><input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} /> Hiện password</label>}
        </form>;
      })}
    </div>
  </section>;
}
