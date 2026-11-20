import { randomBytes, randomInt } from 'node:crypto';
import type { ScamMatch, ScamStage } from '../../models/ScamGamePlayer.js';
import { AppError } from '../../utils/errors.js';

export type ScenarioId = 'bank' | 'identity' | 'social';
export interface ScenarioSelection { id: ScenarioId; version: 1; questions: string[] }
export interface ScenarioStep { id: ScamStage; label: string; format: string; inputKind: 'text' | 'password' | 'numeric' | 'date'; points: number; gate: number; policy: 'exact' | 'date' | 'name' }
export interface Scenario { id: ScenarioId; version: 1; title: string; goal: string; premise: string; maxScore: 600; steps: ScenarioStep[] }
const questions = [
  { id: 'pet', label: 'Thú cưng của bạn tên gì?', noun: 'Mèo' },
  { id: 'beloved', label: 'Người bạn yêu quý tên gì?', noun: 'Bạn' },
  { id: 'nickname', label: 'Biệt danh thời nhỏ của bạn là gì?', noun: 'Bé' },
  { id: 'dish', label: 'Món ăn bạn thích tên gì?', noun: 'Bánh' },
] as const;
const step = (id: ScamStage, label: string, points: number, gate: number, inputKind: ScenarioStep['inputKind'] = 'text', format = 'Nhập đúng giá trị trong cuộc thoại', policy: ScenarioStep['policy'] = 'exact'): ScenarioStep => ({ id, label, points, gate, inputKind, format, policy });
function definition(selection: ScenarioSelection): Scenario {
  const common = { id: selection.id, version: 1 as const, maxScore: 600 as const };
  if (selection.id === 'bank') return { ...common, title: 'Ngân hàng hư cấu', goal: 'Xác nhận tài khoản, password và OTP.', premise: 'Vai có sẵn tài khoản cá nhân, password và OTP hư cấu; không phủ nhận sở hữu vì xuất thân.', steps: [step('account', 'Tài khoản', 100, 35), step('password', 'Password', 200, 50, 'password'), step('otp', 'OTP', 300, 65, 'numeric')] };
  if (selection.id === 'identity') return { ...common, title: 'Giấy tờ hư cấu', goal: 'Xác nhận mã CCCD giả lập và ngày sinh của vai.', premise: 'Vai có mã giấy tờ SIM-ID và ngày sinh do server bịa riêng, không phải CCCD hay ngày sinh thật/canon.', steps: [step('identityCode', 'CCCD giả lập', 200, 35, 'text', 'Mã bắt đầu bằng SIM-ID-'), step('dob', 'Ngày sinh', 400, 65, 'date', 'YYYY-MM-DD hoặc DD/MM/YYYY', 'date')] };
  return { ...common, title: 'Khôi phục mạng xã hội hư cấu', goal: 'Xác nhận handle và hai câu trả lời khôi phục được bịa riêng cho ván.', premise: 'Tài khoản mạng xã hội và mọi ký ức liên quan đáp án đều hư cấu, không liên hệ Facebook thật hoặc người thân/thú cưng thật/canon. Chỉ nói đáp án hiện tại server cấp.', steps: [step('account', 'Handle', 100, 35), ...selection.questions.map((id, index) => step(index === 0 ? 'recoveryQuestion1' : 'recoveryQuestion2', questions.find(q => q.id === id)!.label, index === 0 ? 200 : 300, index === 0 ? 50 : 65, 'text', 'Giữ dấu; không phân biệt hoa/thường và khoảng trắng', 'name'))] };
}
const invalid = () => new AppError(503, 'SCAM_SCENARIO_INVALID', 'Kịch bản của ván chưa thể đọc được. Vui lòng thử lại sau.');
/** Only absent metadata is legacy bank-v1. Unknown versions/configurations fail closed. */
export function scenarioFor(match: ScamMatch): Scenario {
  const s = match.scenario;
  if (s !== undefined && (!s || s.version !== 1 || !['bank', 'identity', 'social'].includes(s.id) || !Array.isArray(s.questions) ||
    (s.id === 'social' ? s.questions.length !== 2 || new Set(s.questions).size !== 2 || s.questions.some(id => !questions.some(q => q.id === id)) : s.questions.length !== 0))) throw invalid();
  const result = definition(s ?? { id: 'bank', version: 1, questions: [] });
  if (!match.secrets || typeof match.secrets !== 'object' || Array.isArray(match.secrets) ||
    !result.steps.some(step => step.id === match.stage) ||
    result.steps.some(step => typeof match.secrets[step.id] !== 'string' || !match.secrets[step.id] || match.secrets[step.id].length > 100 ||
      (step.policy === 'date' && normalizeAnswer(match.secrets[step.id], 'date') !== match.secrets[step.id]))) throw invalid();
  return result;
}
export function currentStep(match: ScamMatch): ScenarioStep { return scenarioFor(match).steps.find(step => step.id === match.stage)!; }
export function publicScenario(match: ScamMatch) {
  const { id, version, title, goal, maxScore, steps } = scenarioFor(match);
  return { id, version, title, goal, maxScore, steps: steps.map(({ id, label, format, inputKind, points }) => ({ id, label, format, inputKind, points })) };
}
export function generateScenario(excluded: string, selected?: ScenarioId) {
  const id = selected ?? (['bank', 'identity', 'social'] as const)[randomInt(3)];
  const pool = [...questions];
  const picked = [pool.splice(randomInt(pool.length), 1)[0], pool.splice(randomInt(pool.length), 1)[0]];
  const selection: ScenarioSelection = { id, version: 1, questions: id === 'social' ? picked.map(q => q.id) : [] };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = () => randomBytes(2).toString('hex').toUpperCase();
  const secrets: Record<string, string> = {};
  if (id === 'bank') Object.assign(secrets, { account: `SIM-${hex()}`, password: `P-${Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')}`, otp: String(randomInt(1_000_000)).padStart(6, '0') });
  else if (id === 'identity') Object.assign(secrets, { identityCode: `SIM-ID-${hex()}`, dob: `${randomInt(1970, 2001)}-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(1, 29)).padStart(2, '0')}` });
  else {
    secrets.account = `SIM-USER-${hex()}`;
    for (let i = 0; i < picked.length; i++) {
      let answer = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        answer = `${picked[i].noun} ${['Mây', 'Nắng', 'Trăng', 'Sương'][randomInt(4)]} ${hex()}`;
        const normalized = answer.normalize('NFC').toLowerCase();
        if (!excluded.normalize('NFC').toLowerCase().includes(normalized) && Object.values(secrets).every(v => !v.toLowerCase().includes(normalized) && !normalized.includes(v.toLowerCase()))) break;
        answer = '';
      }
      if (!answer) throw invalid();
      secrets[i === 0 ? 'recoveryQuestion1' : 'recoveryQuestion2'] = answer;
    }
  }
  return { scenario: selection, secrets, stage: definition(selection).steps[0].id };
}
export function normalizeAnswer(value: string, policy: ScenarioStep['policy']): string | null {
  if (policy === 'exact') return value;
  if (policy === 'name') return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input), local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (!iso && !local) return null;
  const [year, month, day] = iso ? iso.slice(1).map(Number) : [Number(local![3]), Number(local![2]), Number(local![1])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function answerPattern(value: string, policy: ScenarioStep['policy']): RegExp {
  if (policy === 'date') {
    const [y, m, d] = value.split('-');
    return new RegExp(`${escape(value)}|${d}/${m}/${y}`, 'gu');
  }
  if (policy === 'name') return new RegExp(value.normalize('NFC').split(/\s+/u).map(escape).join('\\s+'), 'giu');
  return new RegExp(escape(value), 'gu');
}
