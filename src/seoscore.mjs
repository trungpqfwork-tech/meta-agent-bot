// Chấm điểm bài Facebook marketing theo rubric SEO/social + bắt dấu hiệu văn AI.
//
// Tách riêng khỏi telegram.mjs vì cả marketing.mjs (gate trước khi gửi duyệt) và
// admin.mjs (hiển thị) đều dùng. telegram.mjs re-export để không phá import cũ.

// Danh sách "tell" lấy từ skill humanizer (Wikipedia: Signs of AI writing), lọc
// theo văn bán hàng tiếng Việt. Mục đích không phải cấm từ, mà để bài đọc như
// người bán hàng thật viết: câu dài ngắn xen nhau, nói việc cụ thể, không lên gân.
const AI_TELLS = [
  {id:'em_dash', re:/—/, note:'Dùng gạch dài (—) kiểu văn AI; thay bằng dấu phẩy hoặc dấu chấm'},
  {id:'not_only', re:/không chỉ[^.!?]{0,60}mà còn/i, note:'Mẫu "không chỉ ... mà còn" là dấu hiệu AI'},
  {id:'false_range', re:/từ người mới[^.!?]{0,40}đến|từ chuyên gia[^.!?]{0,40}đến/i, note:'Mẫu "từ A đến B" không cùng thang đo'},
  {id:'hype_words', re:/nâng tầm|giải pháp|đẳng cấp|hoàn hảo|tuyệt vời|hàng đầu|số 1|đỉnh cao|\bđỉnh\b|trọn vẹn|tận hưởng|uy tín|chất lượng vượt trội/i, note:'Từ quảng cáo sáo (nâng tầm, giải pháp, đẳng cấp, hoàn hảo, đỉnh...)'},
  {id:'push_cta', re:/nhanh tay|đừng bỏ lỡ|hãy liên hệ ngay hôm nay|inbox ngay hôm nay|cơ hội cuối/i, note:'CTA thúc ép kiểu quảng cáo'},
  {id:'weasel_opener', re:/trong thế giới|ngày nay|ngày càng|bạn đang (tìm kiếm|mong muốn)|hãy để chúng tôi/i, note:'Mở bài kiểu "ngày nay / bạn đang tìm kiếm"'},
  {id:'rhetorical_question', re:/^[^\n]{12,140}\?/, note:'Mở bài bằng câu hỏi rồi tự trả lời ở câu sau'},
  {id:'wrap_up', re:/\b(tóm lại|kết luận|như vậy|nhìn chung)\b/i, note:'Câu kết kiểu văn nghị luận (tóm lại, kết luận)'},
  {id:'promise', re:/cam kết|đảm bảo (chất lượng|ngon|rẻ)|100%/i, note:'Cam kết/đảm bảo chung chung không có nguồn'},
  {id:'unsupported_ops', re:/\b(hàng sẵn|có sẵn|giao đúng loại|giao hàng|giá tốt|giá mềm|theo thị trường|báo giá sỉ\/?lẻ)\b/i, note:'Có claim vận hành/giá/hàng sẵn chưa chắc có nguồn'},
  {id:'off_topic_food', re:/khoai lang|bánh nếp|mâm cỗ|môm|lấu|phở bắp bò|xào sả|nấu chua|hấp mật ong|saladin/i, note:'Có món/từ lạc chủ đề hoặc lỗi chính tả cần bỏ'},
  {id:'exclaim', re:/!{2,}|![\s]*(?:$|\n)/m, note:'Câu cảm thán gượng'},
];

export function detectAiTells(post) {
  const caption = String(post?.caption ?? '');
  return AI_TELLS.filter(t => t.re.test(caption)).map(t => t.note);
}

export function scoreMarketingSeo(post) {
  const caption = String(post.caption ?? '');
  const firstLine = (caption.split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? '').split(/(?<=[.!?])\s/)[0].trim();
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const hasImage = Array.isArray(post.media) && post.media.some(m => m?.type === 'image');
  const aiTells = detectAiTells(post);
  let score = 0;
  const notes = [];

  if (firstLine.length >= 18 && firstLine.length <= 140 && !/(nâng tầm|giải pháp|khám phá|đồng hành|chất lượng vượt trội|sự lựa chọn hoàn hảo)/i.test(firstLine)) score += 1;
  else notes.push('Câu mở đầu (hook) cần cụ thể, gọn dưới ~140 ký tự');

  if (/tm food|cá hồi|ba chỉ|bò|heo|gà|hải sản|thực phẩm/i.test(caption)) score += 1;
  else notes.push('Thiếu từ khóa sản phẩm/ngành rõ ràng');

  if (/(na uy|chile|úc|aqua|xuất xứ|thương hiệu|áp chảo|nướng|salad|lẩu|phở|xào)/i.test(caption)) score += 1;
  else notes.push('Thiếu dữ kiện có chứng cứ từ KB');

  if (/(gia đình|nhà hàng|quán ăn|bếp ăn|khách sỉ|khách lẻ)/i.test(caption)) score += 1;
  else notes.push('Thiếu đối tượng khách hàng phù hợp');

  if (/inbox|nhắn|comment|liên hệ|tư vấn/i.test(caption)) score += 1;
  else notes.push('Thiếu CTA rõ');

  if (hashtags.length >= 3 && hashtags.length <= 6) score += 1;
  else notes.push('Hashtag nên có 3-6 tag liên quan');

  if (hasImage) score += 2;
  else notes.push('Chưa có ảnh đã duyệt');

  // Bối cảnh bán hàng, không bắt buộc phải là "Thái Bình": Page thật cũng bán cho
  // nhà hàng/quán ăn/đại lý ở nhiều nơi, nên nhóm khách hoặc dịp dùng cũng tính.
  if (/thái bình|cuối tuần|bữa cơm|món ăn|set ăn|nhà hàng|quán ăn|quán nhậu|quán lẩu|quán gà rán|ăn vặt|bếp ăn|đại lý|nấu cỗ|tiệc/i.test(caption)) score += 1;
  else notes.push('Thiếu ngữ cảnh địa phương hoặc tình huống sử dụng');

  if (!/(giảm giá|cam kết|tốt nhất|rẻ nhất|100%|sạch tuyệt đối|an toàn tuyệt đối|cao cấp nhất)/i.test(caption)) score += 1;
  else notes.push('Có cụm từ rủi ro/cam kết mạnh');

  if (!aiTells.length) score += 1;
  else notes.push(`Văn còn mùi AI: ${aiTells.join('; ')}`);

  if (!hasImage) score = Math.min(score, 6);
  if (aiTells.some(n => /lạc chủ đề|vận hành|hàng sẵn|giá/.test(n))) score = Math.min(score, 4);
  else if (aiTells.length) score = Math.min(score, 5);
  // Bài không có CTA thì chưa đủ điều kiện đi duyệt, dù các phần khác ổn.
  if (!/inbox|nhắn|comment|liên hệ|tư vấn/i.test(caption)) score = Math.min(score, 5);
  // Dưới 3 hashtag thì bài gần như không có phần khám phá, chặn ở 6.
  if (hashtags.length < 3) score = Math.min(score, 6);
  if (!/(na uy|chile|úc|aqua|xuất xứ|thương hiệu|áp chảo|nướng|salad|lẩu|phở|xào)/i.test(caption)) score = Math.min(score, 5);
  if (/(giảm giá|khuyến mãi|còn hàng|cam kết|tốt nhất|rẻ nhất|100%)/i.test(caption) && !Array.isArray(post.source_ids)) score = Math.min(score, 3);
  return {score: Math.max(1, Math.min(10, score)), notes, aiTells};
}
