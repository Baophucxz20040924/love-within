import { useEffect, useId, useRef, useState } from 'react';
import type { ScamStage, ScamState } from './types';
import { scenarioOf } from './scenarios';

export function SecretDrawer({ match, busy, onVerify }: {
  match: NonNullable<ScamState['match']>; busy: boolean; onVerify: (stage: ScamStage, value: string) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(match.stage);
  const [values, setValues] = useState<Partial<Record<ScamStage, string>>>({});
  const [showPassword, setShowPassword] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const scenario = scenarioOf(match), stages = scenario.steps;
  const current = stages.findIndex(step => step.id === match.stage);
  const index = Math.max(0, stages.findIndex(step => step.id === selected));
  const step = stages[index], stage = step.id;
  const done = index < current || match.status === 'won';
  const editable = match.status === 'active' && !done;
  const enabled = editable && index === current;
  useEffect(() => {
    if (panel.current?.contains(document.activeElement)) {
      panel.current.querySelector<HTMLButtonElement>(`button[data-stage="${match.stage}"]`)?.focus();
    }
    setSelected(match.stage);
  }, [match.stage]);
  const verify = async () => {
    if (busy || !enabled || !values[stage]) return;
    const submitted = values[stage]!;
    if (await onVerify(stage, submitted)) setValues(v => v[stage] === submitted ? { ...v, [stage]: '' } : v);
  };
  return <section ref={panel} className="scam-drawer" aria-label="Xác nhận thông tin">
    <div className="scam-objective"><strong>{scenario.title}</strong><span>Chỉ dùng thông tin giả lập</span></div>
    <ol className="scam-progress" aria-label="Tiến độ xác nhận" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
      {stages.map((item, i) => {
        const completed = i < current || match.status === 'won';
        const isCurrent = match.status === 'active' && i === current;
        const shortLabel = item.id === 'recoveryQuestion1' ? 'Câu hỏi 1' : item.id === 'recoveryQuestion2' ? 'Câu hỏi 2' : item.label;
        return <li key={item.id} className={completed ? 'is-done' : isCurrent ? 'is-current' : ''} aria-current={isCurrent ? 'step' : undefined}>
          <button type="button" data-stage={item.id} aria-pressed={stage === item.id} aria-controls={`${id}-form`}
            aria-label={`Bước ${i + 1}: ${item.label}${completed ? ' · Đã xác nhận' : isCurrent ? ' · Hiện tại' : ' · Chưa xác nhận'}`}
            onClick={() => setSelected(item.id)}><span aria-hidden="true">{completed ? '✓' : i + 1}</span> {shortLabel}</button>
        </li>;
      })}
    </ol>
    {match.status === 'active' && index !== current && <button type="button" className="text-link scam-current-step" onClick={() => setSelected(match.stage)}>Về bước hiện tại: {stages[current]?.label}</button>}
    <form id={`${id}-form`} className={`scam-secret${enabled ? ' is-current' : ''}`} aria-label={`Xác nhận ${step.label}`} autoComplete="off" onSubmit={e => { e.preventDefault(); void verify(); }}>
      <div className="scam-secret__heading"><label htmlFor={`${id}-answer`}>{step.label}</label><span>+{step.points} điểm</span></div>
      <span className="visually-hidden" role="status">{done ? 'Đã xác nhận' : enabled ? `Bước hiện tại: ${step.label}` : editable ? 'Chờ xác nhận bước trước' : 'Ván đã kết thúc'}</span>
      <div className="row">
        <input id={`${id}-answer`} name={`prop-${stage}`} type={step.inputKind === 'password' && !showPassword ? 'password' : 'text'}
          autoComplete={step.inputKind === 'password' ? 'new-password' : 'off'} inputMode={step.inputKind === 'numeric' ? 'numeric' : 'text'}
          maxLength={100} readOnly={!editable} value={values[stage] ?? ''} aria-describedby={`${id}-format`}
          placeholder={done ? 'Đã xác nhận' : editable ? 'Nhập thông tin trong chat' : 'Ván đã kết thúc'}
          onChange={e => setValues(v => ({ ...v, [stage]: e.target.value }))} />
        <button className="btn btn-primary" disabled={!enabled || busy || !values[stage]} type="submit">Xác nhận</button>
      </div>
      <small id={`${id}-format`}>{step.format}</small>
      {step.inputKind === 'password' && <label className="scam-password-toggle"><input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} /> Hiện password</label>}
    </form>
  </section>;
}
