import type { ScamScenario, ScamState } from './types';

const bank: ScamScenario = {
  id: 'bank', version: 1, title: 'Ngân hàng hư cấu', goal: 'Xác nhận tài khoản, password và OTP.', maxScore: 600,
  steps: [
    { id: 'account', label: 'Tài khoản', points: 100, inputKind: 'text', format: 'Nhập đúng giá trị trong cuộc thoại' },
    { id: 'password', label: 'Password', points: 200, inputKind: 'password', format: 'Nhập đúng giá trị trong cuộc thoại' },
    { id: 'otp', label: 'OTP', points: 300, inputKind: 'numeric', format: 'Giữ cả số 0 ở đầu' },
  ],
};
/** Older responses/fixtures omit metadata; the server owns all new scenario definitions. */
export function scenarioOf(match?: ScamState['match']): ScamScenario { return match?.scenario ?? bank; }
