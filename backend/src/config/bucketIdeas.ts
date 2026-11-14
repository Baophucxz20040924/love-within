// Bản nháp, chủ dự án sẽ duyệt.
//
// Gợi ý cho "Bucket list chung" (plan/ENGINEERING_WORKFLOW.md, CP3): chạm một gợi ý để thêm vào danh sách của hai bạn.
// Quy tắc khi sửa:
// - Không đổi hay xóa `id` đã dùng: mục đã thêm lưu `ideaId` để trang Gợi ý đánh dấu "Đã thêm". Sửa câu chữ, emoji thì được.
// - Gợi ý mới thêm vào cuối, id kế tiếp (b061, b062…).
// - Câu trung tính (không "anh/em"), nhiều mức chi phí, làm được ở Việt Nam. Tiêu đề tối đa 120 ký tự.

import type { BucketCategory } from '../models/BucketItem.js';

export interface BucketIdea {
  id: string;
  title: string;
  emoji: string;
  category: BucketCategory;
}

export const BUCKET_IDEAS: readonly BucketIdea[] = [
  // Du lịch
  { id: 'b001', title: 'Ngắm bình minh trên biển', emoji: '🌅', category: 'travel' },
  { id: 'b002', title: 'Đi Đà Lạt mùa hoa dã quỳ', emoji: '🌼', category: 'travel' },
  { id: 'b003', title: 'Cắm trại qua đêm một lần', emoji: '⛺', category: 'travel' },
  { id: 'b004', title: 'Đi một chặng tàu hỏa Bắc – Nam', emoji: '🚆', category: 'travel' },
  { id: 'b005', title: 'Ngắm ruộng bậc thang mùa lúa chín', emoji: '🌾', category: 'travel' },
  { id: 'b006', title: 'Đi phượt xe máy một chuyến ngắn', emoji: '🛵', category: 'travel' },
  { id: 'b007', title: 'Ngủ một đêm ở homestay giữa núi rừng', emoji: '🏡', category: 'travel' },
  { id: 'b008', title: 'Lần đầu cùng nhau đi nước ngoài', emoji: '🛫', category: 'travel' },
  { id: 'b009', title: 'Khám phá một hòn đảo (Cô Tô, Côn Đảo, Phú Quý…)', emoji: '🏝️', category: 'travel' },
  { id: 'b010', title: 'Thả hoa đăng ở Hội An đêm rằm', emoji: '🏮', category: 'travel' },
  { id: 'b011', title: 'Leo lên một đỉnh núi (Bà Đen, Fansipan…)', emoji: '⛰️', category: 'travel' },
  { id: 'b012', title: 'Một ngày đi chơi không kế hoạch ở thành phố lạ', emoji: '🗺️', category: 'travel' },

  // Ăn uống
  { id: 'b013', title: 'Cùng nấu một bữa tối ba món', emoji: '🍲', category: 'food' },
  { id: 'b014', title: 'Ăn thử hết một con phố ẩm thực', emoji: '🍢', category: 'food' },
  { id: 'b015', title: 'Tự làm bánh sinh nhật cho nhau', emoji: '🎂', category: 'food' },
  { id: 'b016', title: 'Ăn một bữa hải sản thật no ở biển', emoji: '🦐', category: 'food' },
  { id: 'b017', title: 'Đi chợ sớm rồi về nấu bữa sáng', emoji: '🥖', category: 'food' },
  { id: 'b018', title: 'Đi ăn một nhà hàng sang trọng dịp đặc biệt', emoji: '🍷', category: 'food' },
  { id: 'b019', title: 'Tự pha cà phê hoặc trà sữa ở nhà', emoji: '☕', category: 'food' },
  { id: 'b020', title: 'Ăn bún chả, cơm tấm và mì Quảng ở đúng quê của món', emoji: '🍜', category: 'food' },
  { id: 'b021', title: 'Cùng cuốn kimbap hoặc sushi ở nhà', emoji: '🍣', category: 'food' },
  { id: 'b022', title: 'Picnic ở công viên với đồ ăn tự làm', emoji: '🧺', category: 'food' },
  { id: 'b023', title: 'Thử một quán món Thái, Ấn hoặc Mexico', emoji: '🌮', category: 'food' },
  { id: 'b024', title: 'Gói bánh chưng hoặc bánh tét dịp Tết', emoji: '🎍', category: 'food' },

  // Trải nghiệm
  { id: 'b025', title: 'Đi xem một buổi hòa nhạc ngoài trời', emoji: '🎶', category: 'experience' },
  { id: 'b026', title: 'Chơi tàu lượn siêu tốc ở công viên giải trí', emoji: '🎢', category: 'experience' },
  { id: 'b027', title: 'Lặn ngắm san hô', emoji: '🤿', category: 'experience' },
  { id: 'b028', title: 'Đón giao thừa và ngắm pháo hoa cùng nhau', emoji: '🎆', category: 'experience' },
  { id: 'b029', title: 'Chụp một bộ ảnh đôi', emoji: '📸', category: 'experience' },
  { id: 'b030', title: 'Xem phim suất nửa đêm', emoji: '🎬', category: 'experience' },
  { id: 'b031', title: 'Chèo SUP hoặc kayak trên hồ', emoji: '🛶', category: 'experience' },
  { id: 'b032', title: 'Cùng làm tình nguyện một ngày', emoji: '🤝', category: 'experience' },
  { id: 'b033', title: 'Hát karaoke trọn 20 bài', emoji: '🎤', category: 'experience' },
  { id: 'b034', title: 'Đi bộ đường dài hơn 10 km', emoji: '🥾', category: 'experience' },
  { id: 'b035', title: 'Bay dù lượn hoặc đi khinh khí cầu', emoji: '🪂', category: 'experience' },
  { id: 'b036', title: 'Ngắm mưa sao băng', emoji: '🌠', category: 'experience' },

  // Học cùng nhau
  { id: 'b037', title: 'Học một điệu nhảy đôi', emoji: '💃', category: 'learning' },
  { id: 'b038', title: 'Học bơi hoặc bơi xa hơn', emoji: '🏊', category: 'learning' },
  { id: 'b039', title: 'Học một ngoại ngữ, mỗi ngày 10 phút', emoji: '🗣️', category: 'learning' },
  { id: 'b040', title: 'Đọc chung một cuốn sách rồi kể nhau nghe', emoji: '📖', category: 'learning' },
  { id: 'b041', title: 'Học làm gốm', emoji: '🏺', category: 'learning' },
  { id: 'b042', title: 'Tập chơi một bài guitar hoặc ukulele', emoji: '🎸', category: 'learning' },
  { id: 'b043', title: 'Học nấu một món ở quê người kia', emoji: '🥘', category: 'learning' },
  { id: 'b044', title: 'Đi một lớp vẽ tranh', emoji: '🎨', category: 'learning' },
  { id: 'b045', title: 'Học sơ cứu cơ bản', emoji: '🩹', category: 'learning' },
  { id: 'b046', title: 'Trồng một chậu cây và chăm tới khi ra hoa', emoji: '🌱', category: 'learning' },
  { id: 'b047', title: 'Lập kế hoạch tiết kiệm cho một mục tiêu chung', emoji: '💰', category: 'learning' },
  { id: 'b048', title: 'Học pha một ly mocktail', emoji: '🍹', category: 'learning' },

  // Khác
  { id: 'b049', title: 'Xem lại ảnh cũ và làm một cuốn album', emoji: '📔', category: 'other' },
  { id: 'b050', title: 'Trồng một cái cây kỷ niệm', emoji: '🌳', category: 'other' },
  { id: 'b051', title: 'Cùng chăm một bé thú cưng', emoji: '🐶', category: 'other' },
  { id: 'b052', title: 'Tập thể dục cùng nhau 30 ngày liền', emoji: '🏃', category: 'other' },
  { id: 'b053', title: 'Một ngày không điện thoại', emoji: '📵', category: 'other' },
  { id: 'b054', title: 'Về thăm quê của người kia', emoji: '🏘️', category: 'other' },
  { id: 'b055', title: 'Tự tay làm quà tặng nhau', emoji: '🎁', category: 'other' },
  { id: 'b056', title: 'Xem trọn một bộ phim dài tập', emoji: '📺', category: 'other' },
  { id: 'b057', title: 'Chạy một giải chạy 5 km', emoji: '🏅', category: 'other' },
  { id: 'b058', title: 'Cùng trang trí lại một góc nhà', emoji: '🛋️', category: 'other' },
  { id: 'b059', title: 'Đi một lễ hội truyền thống đầu năm', emoji: '🎏', category: 'other' },
  { id: 'b060', title: 'Viết cho nhau một lá thư mở sau 5 năm', emoji: '✉️', category: 'other' },
];

export const BUCKET_IDEAS_BY_ID: ReadonlyMap<string, BucketIdea> = new Map(BUCKET_IDEAS.map((i) => [i.id, i]));
