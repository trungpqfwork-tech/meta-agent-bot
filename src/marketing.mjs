import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseModelJson, normalize } from './knowledge.mjs';
import { loadImageCatalog, imageFilePath, publicImageUrl, imageScores } from './images.mjs';
import { scoreMarketingSeo } from './seoscore.mjs';

function approvedDocs(file) {
  try {
    const docs=JSON.parse(readFileSync(file,'utf8')).documents ?? [];
    const now=Date.now();
    return docs.filter(d=>d.approved===true && (!d.validUntil || Date.parse(d.validUntil)>now)).slice(0,50);
  } catch { return []; }
}
function approvedImages(file) {
  try { return loadImageCatalog(file).filter(i=>i.approved===true).slice(0,50); }
  catch { return []; }
}
function arr(value) { return Array.isArray(value) ? value : []; }
// Ảnh của bài marketing phải được LỌC trước khi đưa cho model: kho đã hơn 200 bản
// ghi, dán cả kho vào prompt thì model trả media rỗng và bài lên Page không có
// ảnh (ca thật 15/10/2026). Dùng đúng bộ khớp từ khoá của CSKH (imageScores:
// trọng số IDF theo từng từ, khớp trọn trước khớp một phần) để lấy danh sách ngắn
// theo chủ đề, rồi mới để model chọn thứ tự đăng.
export function selectPostImages(config, {query='', caption='', docs=[], exclude=[], limit=12}={}) {
  let catalog;
  try { catalog = loadImageCatalog(config.imageCatalogFile).filter(i=>i.approved===true); }
  catch { return []; }
  if(!catalog.length) return [];
  const trim = img => ({id:img.id, title:img.title, keywords:arr(img.keywords), caption:img.caption});
  const ranked=[];
  const push = list => { for(const img of list) if(img?.id && !ranked.some(x=>x.id===img.id)) ranked.push(img); };
  push(imageScores(catalog, String(query ?? '').slice(0,1200)));
  if(ranked.length < limit) {
    const terms=[caption, ...arr(docs).flatMap(d=>[d.title, ...arr(d.keywords)])].filter(Boolean).join(' ');
    if(String(terms).trim()) push(imageScores(catalog, String(terms).slice(0,1200)));
  }
  const blocked=new Set(arr(exclude).map(String));
  const fresh=ranked.filter(i=>!blocked.has(i.id));
  // Ảnh vừa dùng ở bài trước bị đẩy xuống cuối, chỉ quay lại khi chủ đề không còn
  // đủ ảnh mới: bài cùng sản phẩm đăng lại không được lặp y nguyên bộ ảnh cũ.
  const ordered=[...fresh, ...ranked.filter(i=>blocked.has(i.id))];
  return ordered.slice(0, Math.max(1, Number(limit)||12)).map(trim);
}
// Model chỉ được chọn ảnh trong danh sách ngắn; nếu vẫn trả thiếu thì điền thêm
// theo thứ tự khớp để mỗi bài có tối thiểu minImagesPerPost ảnh.
export function ensureMinMedia(media, images, {min=3, max=6}={}) {
  const floor=Math.max(1, Number(min)||1), cap=Math.max(floor, Number(max)||floor);
  const out=[], seen=new Set();
  for(const m of arr(media)) {
    const id = m && m.type==='image' ? String(m.image_id ?? '').trim() : '';
    if(!id || seen.has(id)) continue;
    seen.add(id); out.push({type:'image', image_id:id});
    if(out.length>=cap) break;
  }
  for(const img of arr(images)) {
    if(out.length>=floor || out.length>=cap) break;
    const id=String(img?.id ?? '').trim();
    if(!id || seen.has(id)) continue;
    seen.add(id); out.push({type:'image', image_id:id});
  }
  return {media:out, enough: out.length>=floor};
}
// Hashtag phải có '#' và không lặp lại trong caption, và phải được GẮN vào nội dung
// đăng: nếu chỉ lưu riêng ở cột hashtags thì bài lên Facebook không có hashtag nào.
function normalizeHashtag(tag) {
  const cleaned = String(tag ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '');
  return cleaned ? `#${cleaned}` : '';
}
// Model hay viết hashtag sai (mất dấu lung tung, dính chữ: "#thananh", "#canhoi").
// Nên hashtag cuối cùng luôn được dựng ở đây từ từ khoá sản phẩm/địa phương:
// không dấu, không khoảng trắng, PascalCase, tối đa 6 tag.
const HASHTAG_VOCAB = [
  ['ca hoi', 'CaHoi'], ['ba chi bo', 'BaChiBo'], ['ba chi heo', 'BaChiHeo'], ['bap bo', 'BapBo'], ['bap hoa bo', 'BapHoaBo'],
  ['bo', 'ThitBo'], ['chan ga', 'ChanGa'], ['canh ga', 'CanhGa'], ['bo my', 'BoMy'], ['thit bo', 'ThitBo'], ['thit heo', 'ThitHeo'],
  ['ga my', 'GaMy'], ['toi ga', 'ToiGa'], ['ga nguyen con', 'GaNguyenCon'], ['de suon', 'DeSuon'], ['suon bo', 'SuonBo'],
  ['suon canh buom', 'SuonCanhBuom'], ['duoi heo', 'DuoiHeo'], ['sun non', 'SunNon'], ['ca trung', 'CaTrung'],
  ['ga ta', 'GaTa'], ['hai san', 'HaiSan'], ['tom', 'Tom'], ['muc', 'Muc'], ['ca basa', 'CaBasa'],
  ['brazil', 'Brazil'], ['nhap khau', 'NhapKhau'], ['na uy', 'NaUy'], ['chile', 'Chile'], ['uc', 'Uc'], ['aqua', 'Aqua'], ['jbs', 'JBS'],
  ['dong lanh', 'DongLanh'], ['thuc pham', 'ThucPham'], ['nha hang', 'NhaHang'],
  ['quan an', 'QuanAn'], ['bep an', 'BepAn'], ['gia dinh', 'GiaDinh'], ['tiec', 'Tiec'],
  ['lau', 'Lau'], ['nuong', 'Nuong'], ['thai binh', 'ThaiBinh'], ['tm food', 'TMFood'],
];
function foldDiacritics(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
function pascal(text) {
  return foldDiacritics(text).split(/[^a-z0-9]+/i).filter(Boolean)
    .map(w => (/[A-Z]/.test(w.slice(1)) || w === w.toUpperCase()) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('').slice(0,30);
}
function hasPhrase(haystack, phrase) {
  return new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(haystack);
}
export function buildHashtags(config, {prompt='', caption='', modelTags=[]}={}) {
  // Hashtag lấy từ CAPTION là chính. Nếu lấy từ prompt thì phần KB dán vào prompt
  // (nhắc bò, heo, mực, cá...) sẽ đẻ ra tag sai chủ đề cho bài chỉ nói về tỏi gà.
  const clean = text => normalize(String(text ?? '')).replace(/[^a-z0-9]+/g,' ').trim();
  const haystack = ` ${clean(caption)} `;
  const fallback = ` ${clean(`${caption} ${prompt}`)} `;
  const tags = [];
  for(const [phrase, tag] of HASHTAG_VOCAB) if(hasPhrase(haystack, phrase)) tags.push(tag);
  for(const raw of arr(modelTags)) {
    // Bỏ dấu nhưng GIỮ nguyên chữ hoa/thường để "TMFood" không thành "Tmfood".
    // Chỉ nhận tag model nếu cụm đó thực sự xuất hiện trong caption/prompt;
    // tránh case bài bò Brazil nhưng model tự nhét #Uc.
    const folded = foldDiacritics(String(raw ?? '')).replace(/[^A-Za-z0-9\s]/g, ' ').trim();
    const key = clean(folded);
    if(!folded || folded.length < 3 || folded.length > 40 || !hasPhrase(fallback, key)) continue;
    tags.push(pascal(folded));
  }
  const brand = pascal(config?.pageName ?? '') || 'TMFood';
  const out = [];
  for(const tag of [brand, ...tags]) {
    if(out.length >= 6) break;
    if(tag && !out.includes(tag)) out.push(tag);
  }
  // Facebook vẫn tính hashtag theo tag, nhưng bài có dưới 3 tag gần như không vào
  // phần khám phá, nên bù bằng nhóm chung khi thiếu.
  for(const filler of ['ThucPham', 'DongLanh', 'NhaHang', 'QuanAn']) {
    if(out.length >= 3) break;
    if(!out.includes(filler)) out.push(filler);
  }
  return out.map(t => `#${t}`);
}
export function composePostMessage(caption, hashtags) {
  const body = String(caption ?? '').trim();
  const tags = [...new Set(arr(hashtags).map(normalizeHashtag).filter(Boolean)
    .filter(tag => !body.includes(tag)))];
  return tags.length ? `${body}\n\n${tags.join(' ')}` : body;
}
// Ảnh trong bài marketing được model chọn theo image_id; lúc đăng mới đổi sang
// nguồn thật (URL công khai do edge phục vụ, hoặc file trong runtime/images).
// Không tìm thấy ảnh đã duyệt thì trả null để bài đăng dạng text thay vì lỗi.
export function resolveMarketingImage(config, media) {
  const first = arr(media).find(m => m?.type === 'image' && (m.image_id || m.url || m.filePath));
  if(!first) return null;
  if(first.url) return {url:String(first.url), filePath:''};
  if(first.filePath) return {url:'', filePath:String(first.filePath)};
  let entry;
  try { entry = loadImageCatalog(config.imageCatalogFile).find(i => i.id === first.image_id && i.approved === true); }
  catch { return null; }
  if(!entry) return null;
  const filePath = imageFilePath(dirname(config.imageDir), entry);
  const local = filePath && existsSync(filePath) ? filePath : '';
  const url = entry.url ?? publicImageUrl(config.publicWebhookUrl, entry);
  if(url) return {url, filePath:local};
  return local ? {url:'', filePath:local} : null;
}
export function resolveMarketingImages(config, media, max=6) {
  const out=[];
  for(const m of arr(media).slice(0, Math.max(1, Number(max)||6))) {
    const one=resolveMarketingImage(config, [m]);
    if(one) out.push(one);
  }
  return out;
}
function cleanCaption(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(has_?tags|hashtags)\s*:/i.test(line))
    // Model đôi khi lỡ đưa keyword hashtag thô vào cuối caption dù JSON đã có hashtags.
    .filter(line => !(/^[a-z0-9 ,_-]+$/i.test(line.trim()) && line.includes(',') && /(tmfood|thuc pham|dong lanh|nha hang|nguon hang|gia si|bap|bo|heo|ca|tom|muc)/i.test(line)))
    .join('\n')
    .trim();
}
function validateDraft(raw,{docs=[],images=[],config=null,topic=''}={}) {
  const caption=cleanCaption(raw.caption);
  const draft={
    title_internal:String(raw.title_internal??'').trim().slice(0,500),
    caption:caption.slice(0,5000),
    hashtags:buildHashtags(config,{prompt:topic,caption,modelTags:raw.hashtags}),
    cta:String(raw.cta??'').trim().slice(0,500),
    media:arr(raw.media).slice(0,6),
    link:String(raw.link??'').trim().slice(0,1000),
    source_ids:arr(raw.source_ids).map(x=>String(x).trim()).filter(Boolean).slice(0,20),
    risk_flags:arr(raw.risk_flags).map(x=>String(x).trim()).filter(Boolean).slice(0,20)
  };
  if(!draft.caption) throw new Error('Marketing caption required');
  const sourceIds=new Set(docs.map(d=>d.id));
  for(const id of draft.source_ids) if(!sourceIds.has(id)) throw new Error(`Unknown marketing source: ${id}`);
  const imageIds=new Set(images.map(i=>i.id));
  for(const m of draft.media) if(m?.type==='image' && m.image_id && !imageIds.has(m.image_id)) throw new Error(`Unknown marketing image: ${m.image_id}`);
  return draft;
}
function isProductishDoc(d) {
  return /^product-|^category-|^usage-|^brand-/.test(String(d.id??''));
}
function recentPostStyle(posts) {
  return arr(posts).slice(0,12).map(p=>{
    const msg=String(p.message??'').slice(0,1500);
    const lines=msg.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    return {
      id:String(p.id??''),
      created_time:String(p.created_time??''),
      first_line:lines[0]??'',
      line_count:lines.length,
      hashtags:msg.match(/#[\p{L}\p{N}_]+/gu)?.slice(0,10)??[],
      has_image:arr(p.attachments).some(a=>a.has_media||/photo|image/i.test(a.media_type??'')),
      sample:lines.slice(0,8).join('\n').slice(0,900)
    };
  }).filter(p=>p.first_line);
}
function topicCandidates(docs, images, recentPosts=[]) {
  const recentText=normalize(arr(recentPosts).map(p=>p.message||p.first_line||'').join(' '));
  const imageText=normalize(arr(images).map(i=>[i.id,i.title,arr(i.keywords).join(' ')].join(' ')).join(' '));
  return docs.filter(isProductishDoc).slice(0,40).map(d=>{
    const text=normalize(`${d.title} ${arr(d.keywords).join(' ')} ${d.content}`);
    const hasImage=arr(d.keywords).some(k=>imageText.includes(normalize(k))) || imageText.includes(normalize(d.title));
    const recentlyPosted=arr(d.keywords).some(k=>normalize(k).length>=4 && recentText.includes(normalize(k)));
    return {id:d.id,title:d.title,keywords:arr(d.keywords).slice(0,12),hasImage,recentlyPosted,content:String(d.content).slice(0,800)};
  });
}
function autoTopicPrompt(config,{instruction='',stylePosts=[]}={},docs,images,recentPosts=[]) {
  const candidates=topicCandidates(docs,images,recentPosts);
  return `Bạn chọn CHỦ ĐỀ cho một bài Facebook Page ${config.pageName}. Chỉ chọn từ KB đã duyệt, không viết bài ở bước này.

Mục tiêu:
- Ưu tiên chủ đề có ảnh đã duyệt.
- Tránh lặp sản phẩm/chủ đề đã đăng gần đây.
- Chọn chủ đề có đủ dữ kiện để viết bài bán hàng kiểu TM Food.
- Bài đã đăng bên dưới chỉ dùng để học format/giọng văn, KHÔNG dùng làm nguồn facts.

Yêu cầu admin: ${instruction || 'Tự chọn chủ đề phù hợp để viết bài mới.'}

Bài đã đăng gần đây (style reference): ${JSON.stringify(recentPostStyle(stylePosts).slice(0,10))}
Chủ đề đã đăng gần đây (để tránh lặp): ${JSON.stringify(recentPostStyle(recentPosts).map(p=>p.first_line).slice(0,12))}
Candidate từ KB: ${JSON.stringify(candidates)}

Trả JSON duy nhất:
{"topic":"tên/chủ đề cụ thể","prompt":"brief cụ thể để viết bài, gồm sản phẩm, nguồn facts, khách phù hợp, món/cách dùng; không đưa facts ngoài KB","tone":"style TM Food học từ bài đã đăng","source_ids":["id KB được chọn"],"reason":"vì sao chọn"}`;
}
function marketingPrompt(config,{prompt,tone,scheduledAt,feedback='',stylePosts=[]},docs,images) {
  return `Bạn viết bài Facebook cho Page ${config.pageName}. Style ưu tiên là bài bán hàng Facebook như mẫu TM Food: nhìn vào là thấy sản phẩm, món dùng được, khách hàng phù hợp, lợi ích mua sỉ/lẻ và cách liên hệ. Không viết kiểu đoạn văn blog.

Chỉ dùng dữ liệu nội bộ đã duyệt và yêu cầu của admin. Không bịa giá, tồn kho, khuyến mãi, chứng nhận, chính sách, số điện thoại hoặc cam kết chất lượng. Nếu thiếu dữ kiện, bỏ dòng đó hoặc dùng inbox/comment thay cho hotline.

Trả JSON duy nhất với keys title_internal, caption, hashtags, cta, media, link, scheduled_at_hint, source_ids, risk_flags, confidence.

FORMAT BẮT BUỘC cho caption, theo bài mẫu đẹp:
1. Dòng 1: tiêu đề ngắn có emoji sản phẩm + TÊN SẢN PHẨM viết nổi bật, ví dụ "🥩 BẮP HOA BÒ - GIÒN NGON SẦN SẬT, ĐA DẠNG MÓN NGON". Không dùng dấu gạch dài kiểu —/–.
2. Đoạn mô tả 1-2 câu mở bằng emoji phù hợp như 🔥, nói đúng sản phẩm, xuất xứ/đặc điểm/cách dùng có trong KB.
3. Một block "✅ Chế biến đa dạng:" rồi 2-5 dòng món/cách chế biến nếu KB có món/cách dùng rõ ràng. Nếu KB chỉ nói nhóm khách/hoàn cảnh dùng (nhà hàng, quán ăn, bếp ăn, nấu cỗ, tiệc) mà không nêu món cụ thể, ĐỔI THÀNH block "✅ Phù hợp cho:" và chỉ liệt kê nhóm khách/hoàn cảnh. Không tự thêm món như xào sả ớt, nấu chua, hấp mật ong, salad, khoai lang, bánh nếp, mâm cỗ.
4. Một dòng định vị: "💯 ${config.pageName} - ..." nêu vai trò cho nhà hàng, quán ăn, bếp ăn, đại lý nếu KB hỗ trợ. Không tự nhận số 1/uy tín/chất lượng vượt trội.
5. 2-4 dòng checklist bắt đầu bằng "✔" về nguồn gốc/cách dùng/đối tượng khách nếu có nguồn. Không viết hàng sẵn, giao hàng, giá tốt, giá mềm, báo giá sỉ/lẻ theo thị trường, hỗ trợ cắt nếu KB/admin prompt không nói rõ.
6. CTA cuối: "📞 Liên hệ ${config.pageName} để nhận báo giá/tư vấn" hoặc "💬 Inbox/comment để được tư vấn". Chỉ ghi số điện thoại nếu admin prompt hoặc KB có số.
7. Hashtags: trả về 4-6 cụm từ khoá ngắn, KHÔNG dấu, KHÔNG ký tự # (ví dụ: "bap hoa bo", "thit bo nhap khau", "thuc pham dong lanh"). Hệ thống tự ghép thành hashtag chuẩn.
8. Ảnh: danh sách "Ảnh liên quan" bên dưới ĐÃ ĐƯỢC LỌC theo chủ đề. Chọn TỐI THIỂU 3 ảnh (tối đa 6) nếu danh sách có từ 3 ảnh, xếp theo thứ tự muốn đăng, chỉ dùng image_id trong danh sách đó: media [{"type":"image","image_id":"..."}]. Chỉ khi danh sách dưới 3 ảnh mới lấy hết và thêm risk_flags "fewer_images_than_min".

Cách viết cho ra bài đẹp:
- Được dùng emoji chức năng giống mẫu: 🥩 🔥 ✅ 🍲 🍛 🍜 💯 ✔ 📞 ☎ 💬. Emoji phải đúng sản phẩm (gà thì 🐔/🍗, heo 🐷, bò 🥩, cá 🐟, hải sản 🦐/🐙) và giúp quét nội dung, không rải lung tung.
- Dùng bullet/list ngắn, dễ nhìn trên Facebook. Mỗi dòng 1 ý.
- Từ ngữ bán hàng được phép tự nhiên: giòn ngon, sần sật, thơm, béo, ngọt, tiện, đa dạng món nếu phù hợp với KB/sản phẩm. Không nói "tươi", "sạch", "cao cấp", "cam kết", "100%" nếu không có nguồn.
- Dòng tiêu đề và hashtag phải làm rõ sản phẩm; không viết chung chung "thực phẩm chất lượng".
- Bài luôn cần ảnh: ít nhất 3 ảnh khi danh sách ảnh liên quan có đủ, và ảnh phải đúng sản phẩm đang nói (không lấy ảnh hàng khác cho đủ số).

Cấm hẳn (bài sẽ bị chấm điểm thấp nếu vi phạm):
- Từ sáo AI/quảng cáo: nâng tầm, giải pháp, đẳng cấp, hoàn hảo, tuyệt vời, hàng đầu, số 1, đỉnh/đỉnh cao, trọn vẹn, tận hưởng, chất lượng vượt trội.
- Dấu gạch dài "—" (không dùng; dấu "–" trong dòng tiêu đề thì được vì Page đang dùng), dấu chấm than chồng, mở bài "ngày nay/bạn đang tìm kiếm", kết "tóm lại/kết luận".
- Mẫu "không chỉ ... mà còn", "từ A đến B", CTA thúc ép "nhanh tay/đừng bỏ lỡ/hãy liên hệ ngay hôm nay".
- Bịa giá, tồn kho, khuyến mãi, số điện thoại, chứng nhận, giao hàng, hàng sẵn, báo giá sỉ/lẻ, hỗ trợ cắt, bảo hành/cam kết nếu dữ liệu không nói rõ.

Tự chấm trước khi trả lời: không ảnh tối đa 6/10; thiếu dữ kiện sản phẩm tối đa 5/10; thiếu block chế biến/checklist/CTA thì viết lại; còn mùi AI thì viết lại.

Tone: ${tone || config.marketing?.defaultTone || 'bán hàng Facebook rõ ý, gọn, đẹp như bài mẫu TM Food'}
Yêu cầu admin: ${prompt}
Lịch gợi ý: ${scheduledAt || ''}${feedback ? `\n\nBẢN TRƯỚC CHƯA ĐẠT, phải viết lại:\n${feedback}` : ''}
Bài Page đã đăng để học style (CHỈ học format/giọng văn/hashtag, KHÔNG lấy facts): ${JSON.stringify(recentPostStyle(stylePosts).slice(0,8))}
Tài liệu đã duyệt: ${JSON.stringify(docs.map(d=>({id:d.id,title:d.title,content:String(d.content).slice(0,1000)})))}
Ảnh liên quan (chỉ chọn trong danh sách này): ${JSON.stringify(images.map(i=>({id:i.id,title:i.title,caption:i.caption,keywords:i.keywords})))}`;
}
function dayStart(ms) { const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function minutesInZone(ms, timezone) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ms));
  const hour=Number(parts.find(p=>p.type==='hour')?.value ?? 0), minute=Number(parts.find(p=>p.type==='minute')?.value ?? 0);
  return hour*60+minute;
}
function isQuiet(ms,{timezone='Asia/Ho_Chi_Minh',quietHours='22:00-07:00'}={}) {
  const m=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(quietHours); if(!m) return false;
  const start=Number(m[1])*60+Number(m[2]), end=Number(m[3])*60+Number(m[4]), now=minutesInZone(ms,timezone);
  return start<end ? now>=start && now<end : now>=start || now<end;
}

export function createMarketing(config,store,complete,meta,{setIntervalFn=setInterval,clearIntervalFn=clearInterval,notifier=null}={}) {
  // Viết bài, chấm điểm, và nếu dưới ngưỡng thì viết lại (tối đa reviseAttempts
  // lần) với phản hồi nêu đúng lỗi cần sửa. Chỉ giữ bản điểm cao nhất.
  async function generateDraft({prompt='',tone='',scheduledAt=0,stylePosts=[],sourceIds=null,excludeImageIds=[]}) {
    const allDocs=approvedDocs(config.knowledgeFile), allImages=approvedImages(config.imageCatalogFile);
    const allowed=new Set(arr(sourceIds));
    const docs=allowed.size ? allDocs.filter(d=>allowed.has(d.id)) : allDocs;
    const shortlist=selectPostImages(config,{query:prompt,docs,exclude:excludeImageIds});
    const images=shortlist.length ? shortlist : allImages;
    const minScore=Number(config.marketing?.minScore??0);
    const reviseAttempts=minScore>0?Math.max(0,Number(config.marketing?.reviseAttempts??0)):0;
    let best=null, bestSeo=null;
    for(let attempt=0; attempt<=reviseAttempts; attempt++) {
      const feedback=attempt===0?'':[
        `Bản trước bị chấm ${bestSeo.score}/10, dưới ngưỡng ${minScore}/10.`,
        bestSeo.notes.length?`Lỗi cần sửa: ${bestSeo.notes.join('; ')}.`:'',
        'Viết lại hoàn toàn, giữ đúng dữ kiện KB, không thêm số liệu hay cam kết mới.'
      ].filter(Boolean).join(' ');
      const text=await complete({agentId:config.agentId,message:marketingPrompt(config,{prompt,tone,scheduledAt,feedback,stylePosts},docs,images),system:'Bạn viết bài Facebook marketing và chỉ trả JSON.',timeoutMs:config.agentTimeoutMs});
      const parsed=parseModelJson(text);
      const draft=validateDraft(parsed,{docs,images,config,topic:prompt});
      const seo=scoreMarketingSeo(draft);
      if(!best || seo.score>bestSeo.score) { best=draft; bestSeo=seo; }
      if(seo.score>=minScore) break;
    }
    return {draft:best,seo:bestSeo,minScore};
  }
  async function createDraft({prompt='',tone='',scheduledAt=0,approvedBy='admin',stylePosts=[],sourceIds=null,excludeImageIds=[]}={}) {
    if(!config.marketing?.enabled) throw new Error('marketing disabled');
    const minImages=Math.max(1,Number(config.marketing?.minImagesPerPost??3));
    const maxImages=6;
    const alreadyUsed=arr(store.listMarketingPosts({limit:10}))
      .flatMap(p=>arr(JSON.parse(p.media||'[]')).map(m=>m?.image_id)).filter(Boolean).map(String);
    const exclude=[...new Set([...arr(excludeImageIds).map(String), ...alreadyUsed])];
    const {draft,seo,minScore}=await generateDraft({prompt,tone,scheduledAt,stylePosts,sourceIds,excludeImageIds:exclude});
    const selected=arr(sourceIds).length ? approvedDocs(config.knowledgeFile).filter(d=>sourceIds.includes(d.id)) : [];
    const shortlist=selectPostImages(config,{query:prompt,caption:draft.caption,docs:selected,exclude});
    const {media,enough}=ensureMinMedia(draft.media,shortlist,{min:minImages,max:maxImages});
    draft.media=media;
    draft.risk_flags=draft.risk_flags.filter(f=>f!=='no_approved_image_available' && f!=='fewer_images_than_min');
    if(!enough) draft.risk_flags=[...new Set([...draft.risk_flags,'fewer_images_than_min'])];
    const below=minScore>0 && seo.score<minScore;
    const riskFlags=below?[...new Set([...draft.risk_flags,`low_seo_score_${seo.score}`])]:draft.risk_flags;
    const post=store.createMarketingPost({...draft,risk_flags:riskFlags,topic:prompt});
    // lowScoreAction=hold: bài dưới ngưỡng không được đẩy lên Telegram, chỉ nằm
    // trong admin UI để chủ Page tự xem/sửa.
    const hold=below && config.marketing?.lowScoreAction==='hold';
    if(!hold) { try { await notifier?.notifyMarketingPreview?.(post); } catch {} }
    return hold ? {...post,held:true,seo} : post;
  }
  async function createAutoDraft({instruction='',tone='',scheduledAt=0,approvedBy='admin'}={}) {
    if(!config.marketing?.enabled) throw new Error('marketing disabled');
    const docs=approvedDocs(config.knowledgeFile), images=approvedImages(config.imageCatalogFile);
    const recentLocal=store.listMarketingPosts({limit:20}).map(p=>({id:p.id,created_time:new Date(p.created||Date.now()).toISOString(),message:p.caption,attachments:[]}));
    let stylePosts=[];
    try { stylePosts=meta.listPublishedPosts ? await meta.listPublishedPosts({limit:12}) : []; } catch { stylePosts=[]; }
    const chooserText=await complete({
      agentId:config.agentId,
      message:autoTopicPrompt(config,{instruction,stylePosts},docs,images,[...stylePosts,...recentLocal]),
      system:'Bạn chọn chủ đề Facebook marketing và chỉ trả JSON.',
      timeoutMs:config.agentTimeoutMs
    });
    const chosen=parseModelJson(chooserText);
    const sourceSet=new Set(docs.map(d=>d.id));
    const sourceIds=arr(chosen.source_ids).map(x=>String(x).trim()).filter(id=>sourceSet.has(id)).slice(0,8);
    if(!String(chosen.prompt??chosen.topic??'').trim()) throw new Error('Auto topic chooser returned no topic');
    const selectedDocs=sourceIds.length?docs.filter(d=>sourceIds.includes(d.id)):[];
    const prompt=[
      `AUTO_TOPIC: ${String(chosen.topic??'').slice(0,200)}`,
      instruction?`Yêu cầu admin: ${String(instruction).slice(0,500)}`:'',
      'Viết bài CHỈ từ các source_ids đã chọn bên dưới. Bỏ qua mọi facts nằm trong bài đã đăng cũ hoặc trong lý do chọn nếu không xuất hiện trong KB.',
      sourceIds.length?`source_ids đã chọn: ${sourceIds.join(', ')}`:'',
      selectedDocs.length?`KB được phép dùng: ${JSON.stringify(selectedDocs.map(d=>({id:d.id,title:d.title,content:String(d.content).slice(0,1000)})))}`:'',
      String(chosen.reason??'')?`Lý do chọn topic (không phải nguồn facts): ${String(chosen.reason).slice(0,300)}`:''
    ].filter(Boolean).join('\n');
    return createDraft({prompt,tone:tone||chosen.tone||'bán hàng Facebook giống bài đã đăng của TM Food',scheduledAt,approvedBy,stylePosts,sourceIds});
  }
  async function publishNow(id,{quietHourOverride=false,now=Date.now()}={}) {
    if(!config.marketing?.enabled) throw new Error('marketing disabled');
    if(config.mode!=='live') throw new Error('draft mode blocks marketing publish');
    const current=store.marketingPost(id);
    if(!current) throw new Error('Marketing post not found');
    if(!current.approved_at) throw new Error('Marketing post is not approved');
    if(current.status==='scheduled' && !quietHourOverride && isQuiet(now,config.marketing)) throw new Error('marketing quiet hours block scheduled publish');
    const start=dayStart(now);
    if(store.marketingPublishedCountForDay(start,start+86400000) >= config.marketing.maxPostsPerDay) throw new Error('marketing daily limit reached');
    const reserved=store.reserveMarketingPublish(id);
    if(!reserved) throw new Error('Marketing post cannot be published');
    try {
      const media=JSON.parse(reserved.media || '[]');
      const message=composePostMessage(reserved.caption, JSON.parse(reserved.hashtags || '[]'));
      const images=resolveMarketingImages(config, media);
      let postId;
      if(images.length>=2) postId=await meta.publishMultiPhotoPost({caption:message,images});
      else if(images.length===1) postId=await meta.publishPhotoPost({caption:message,imageUrl:images[0].url,filePath:images[0].filePath});
      else postId=await meta.publishFeedPost({message,link:reserved.link});
      const read=await meta.readPost(postId);
      return store.markMarketingPublished(id,{facebookPostId:read.id,facebookPermalink:read.permalink_url,publishedAt:Date.now()});
    } catch(e) {
      if(e.name==='TimeoutError' || /timeout/i.test(e.message)) return store.markMarketingUnknown(id,e.message);
      store.markMarketingFailed(id,e.message);
      throw e;
    }
  }
  async function tick(now=Date.now()) {
    if(!config.marketing?.enabled || config.mode!=='live') return 0;
    let count=0;
    for(const post of store.marketingPostsDue(now,10)) {
      try { await publishNow(post.id,{now}); count++; } catch {}
    }
    return count;
  }
  function recoverStalePublishing(cutoff=Date.now()-300000) { return store.markStaleMarketingPublishingUnknown(cutoff); }
  async function permissions() { return meta.probePostPermissions ? meta.probePostPermissions() : {granted:[],missing:['permission_probe_unavailable']}; }
  function start(onError=()=>{}) {
    if(!config.marketing?.enabled) return {stop(){}};
    recoverStalePublishing();
    const timer=setIntervalFn(()=>tick().catch(onError),60000);
    return {stop(){clearIntervalFn(timer);}};
  }
  return {createDraft,createAutoDraft,publishNow,tick,recoverStalePublishing,start,permissions,validateDraft};
}

export { validateDraft, scoreMarketingSeo };
