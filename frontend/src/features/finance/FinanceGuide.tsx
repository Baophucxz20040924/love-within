import { Icon } from '../../components/Icon';
import { THUEAPIBANK_URL } from './api';

export const FINANCE_GUIDE_PATH = '/finance/guide';

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-link">
      {children}
      <Icon name="externalLink" size={13} />
    </a>
  );
}

/**
 * The self-service steps every member of every couple follows to link their own MBBank account.
 * Shared by the link wizard and the always-available guide page, so both stay identical.
 */
export function GuideSteps({ withAppStep = true }: { withAppStep?: boolean }) {
  return (
    <ol className="steps">
      <li>
        <span>
          Đăng ký tài khoản tại <ExternalLink href={`${THUEAPIBANK_URL}/register`}>thueapibank.vn</ExternalLink>. Mỗi người tự
          đăng ký bằng tài khoản của mình.
        </span>
      </li>
      <li>
        <span>
          Nạp tiền rồi mua gói ở mục <strong>Gia hạn API</strong>. Gói rẻ nhất cho 1 tài khoản MB là <strong>API Bank 3</strong>{' '}
          (15.000đ/tháng, có thuê theo ngày để thử; giá tháng 11/2026).
        </span>
      </li>
      <li>
        <span>
          Đăng nhập thử <ExternalLink href="https://online.mbbank.com.vn/">online.mbbank.com.vn</ExternalLink> để chắc tài khoản MB
          đăng nhập web được.
        </span>
      </li>
      <li>
        <span>
          Trên thueapibank vào <strong>MBBank → Thêm mới</strong>, nhập tên đăng nhập, mật khẩu, số tài khoản MB rồi bấm{' '}
          <strong>Thêm Ngay</strong>.
        </span>
      </li>
      <li>
        <span>
          Ở trang <strong>Danh sách tài khoản MBBANK</strong>, copy chuỗi ở cột <strong>TOKEN</strong> (32 ký tự).
        </span>
      </li>
      {withAppStep && (
        <li>
          <span>
            Trong app vào <strong>Hồ sơ → Dòng tiền → Liên kết ngân hàng</strong>, dán token và 4 số cuối số tài khoản.
          </span>
        </li>
      )}
    </ol>
  );
}

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Mỗi người trong couple có phải tự liên kết không?',
    a: 'Có. Mỗi người tự đăng ký thueapibank, tự thêm tài khoản MB của mình và tự dán token. Hai người không dùng chung token.',
  },
  {
    q: 'App có biết mật khẩu ngân hàng của tôi không?',
    a: 'Không. Bạn nhập mật khẩu MB trên thueapibank.vn. App chỉ nhận token và lưu ở dạng mã hóa.',
  },
  {
    q: 'App lưu những gì?',
    a: 'Chỉ số tiền, tiền vào hay ra và thời gian của từng giao dịch, cộng ghi chú bạn tự viết. Không lưu nội dung chuyển khoản, số dư hay số tài khoản.',
  },
  {
    q: 'Người ấy có thấy giao dịch của tôi không?',
    a: 'Mặc định là không. Bạn bật “Cho người ấy xem” trong Hồ sơ → Dòng tiền thì người ấy mới xem được giao dịch và ghi chú. Người ấy không sửa được ghi chú của bạn.',
  },
  {
    q: 'Giao dịch mới bao lâu thì hiện?',
    a: 'Khoảng 2 phút. Mở trang Dòng tiền thì app cập nhật ngay. Lần liên kết đầu nhập được khoảng 7 ngày gần nhất.',
  },
  {
    q: 'Có rủi ro gì không?',
    a: 'thueapibank là dịch vụ bên thứ ba, không phải đối tác chính thức của MB. Theo điều khoản của họ, tài khoản MB có thể bị khóa tạm thời hoặc phải xác thực lại, và họ không bồi thường.',
  },
  {
    q: 'App báo “Mất kết nối ngân hàng” thì làm gì?',
    a: 'Kiểm tra gói trên thueapibank.vn còn hạn và tài khoản MB vẫn bật. Rồi bấm “Thử lại”. Nếu token đã đổi, ngắt kết nối (giữ lịch sử) rồi liên kết lại bằng token mới.',
  },
  {
    q: 'Muốn dừng hẳn thì sao?',
    a: 'Vào Hồ sơ → Dòng tiền → Ngắt kết nối (giữ hoặc xóa lịch sử), rồi xóa tài khoản MB trên thueapibank.vn để bot của họ dừng đăng nhập MB.',
  },
];

/** Full guide: steps + FAQ. Rendered on /finance/guide. */
export function FinanceGuide() {
  return (
    <>
      <div className="card stack">
        <p className="card__title">Các bước liên kết</p>
        <p className="text-sm text-muted">
          Hướng dẫn này dành cho mọi người trong mọi couple. Mỗi người làm một lần cho tài khoản MB của mình, mất khoảng 5 phút.
        </p>
        <GuideSteps />
      </div>
      <div className="section">
        <h2 className="section__title">Câu hỏi thường gặp</h2>
        <div className="list">
          {FAQ.map((f) => (
            <details key={f.q} className="faq">
              <summary className="faq__q">{f.q}</summary>
              <p className="faq__a">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </>
  );
}
