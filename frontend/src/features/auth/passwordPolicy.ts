/** Match the server's bcrypt limit without silently truncating multi-byte passwords. */
export function newPasswordError(password: string, confirmation: string): string | null {
  if (password.length < 8) return 'Mật khẩu mới cần ít nhất 8 ký tự.';
  if (new TextEncoder().encode(password).length > 72) return 'Mật khẩu mới không được vượt quá 72 byte UTF-8.';
  if (password !== confirmation) return 'Xác nhận mật khẩu chưa khớp.';
  return null;
}
