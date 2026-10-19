import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseModelJson, normalize } from './knowledge.mjs';
import { loadImageCatalog, imageFilePath, publicImageUrl, imageScores } from './images.mjs';
import { scoreMarketingSeo } from './seoscore.mjs';

function approvedDocs(file) {
  try {
    const docs=JSON.parse(readFileSync(file,'utf8')).documents ?? [];
    const now=Date.now();
    return docs.filter(d=>d.approved===true && (!d.validUntil || Date.parse(d.validUntil)>now)).slice(0,80);
  } catch { return []; }
}
// Tài liệu liên hệ (hotline) luôn phải vào prompt viết bài, kể cả khi source_ids
// chỉ chọn tài liệu sản phẩm: mọi bài đăng đều phải có hotline của Page.
const CONTACT_DOC_ID=/^(policy|brand|contact|info)[-_]?(hotline|contact|lien-?he)/i;
export function withContactDocs(docs, allDocs) {
  const contact=arr(allDocs).filter(d=>CONTACT_DOC_ID.test(String(d?.id??'')) || /hotline/i.test(String(d?.title??'')));
  const have=new Set(arr(docs).map(d=>d?.id));
  return [...arr(docs), ...contact.filter(d=>!have.has(d.id))];
}
function approvedImages(file, limit=50) {
  try {
    const images=loadImageCatalog(file).filter(i=>i.approved===true);
    // limit hữu hạn chỉ dùng để chặn prompt phình; nơi chỉ cần kiểm tra "có ảnh hay
    // không" (bộ chọn chủ đề) phải thấy TOÀN BỘ kho, nếu không sản phẩm thêm sau sẽ
    // vĩnh viễn không được chọn.
    return Number.isFinite(limit) ? images.slice(0,limit) : images;
  } catch { return []; }
}
function arr(value) { return Array.isArray(value) ? value : []; }
// Prompt gửi model có ngân sách ký tự: cắt theo số tài liệu cứng sẽ âm thầm bỏ sản
// phẩm, còn dán hết thì model trả JSON rỗng. Giữ tài liệu theo thứ tự và dừng khi
// chạm ngân sách.
function docPayload(docs, {budget=24000, perDoc=1000}={}) {
  const out=[]; let used=0;
  for(const d of arr(docs)) {
    const item={id:d.id,title:d.title,content:String(d.content).slice(0,perDoc)};
    const size=JSON.stringify(item).length;
    if(out.length && used+size>budget) break;
    out.push(item); used+=size;
  }
  return out;
}
// Ảnh của bài marketing phải được LỌC trước khi đưa cho model: kho đã hơn 200 bản
// ghi, dán cả kho vào prompt thì model trả media rỗng và bài lên Page không có
// ảnh (ca thật 15/10/2026). Dùng đúng bộ khớp từ khoá của CSKH (imageScores:
// trọng số IDF theo từng từ, khớp trọn trước khớp một phần) để lấy danh sách ngắn
// theo chủ đề, rồi mới để model chọn thứ tự đăng.
// Ảnh mà tài liệu KB gán cho mặt hàng (dòng "Ảnh: ga-nguyen-con-1, ...") là ảnh
// người vận hành đã chọn cho đúng mặt hàng đó.
export function docAssignedImageIds(docs=[], images=[]) {
  const ids=[];
  for(const d of arr(docs)) {
    const line=/Ảnh:\s*([^\n]+)/i.exec(String(d?.content ?? ''));
    if(!line) continue;
    // Tài liệu hay viết "Ảnh: ga-1, ga-2." ở cuối câu: bỏ dấu câu dính sau id,
    // nếu không id cuối bị coi là không tồn tại và mất ảnh đúng.
    for(const raw of line[1].split(/[,;]/)) { const id=raw.trim().replace(/[.,;:\s]+$/,''); if(id) ids.push(id); }
  }
  const available=new Set(arr(images).map(i=>String(i?.id ?? '')));
  return [...new Set(ids)].filter(id=>!available.size || available.has(id));
}
export function selectPostImages(config, {query='', caption='', docs=[], exclude=[], limit=12}={}) {
  let catalog;
  try { catalog = loadImageCatalog(config.imageCatalogFile).filter(i=>i.approved===true); }
  catch { return []; }
  if(!catalog.length) return [];
  const trim = img => ({id:img.id, title:img.title, keywords:arr(img.keywords), caption:img.caption});
  const byId=new Map(catalog.map(img=>[img.id, img]));
  const ranked=[];
  const push = list => { for(const img of list) if(img?.id && !ranked.some(x=>x.id===img.id)) ranked.push(img); };
  // Tài liệu KB ghi rõ ảnh của mặt hàng ("Ảnh: ga-nguyen-con-1, ..."). Đó là ảnh
  // người vận hành đã gán cho đúng mặt hàng nên xếp trước ảnh khớp từ khoá: model
  // hay copy id từ dòng "Ảnh:" trong tài liệu, mà danh sách gửi model lại bị cắt
  // theo điểm khớp nên id đúng có thể không có trong danh sách đó (ca thật
  // 15/10/2026: draft gấu bò bị chặn vì id gau-bo-1 nằm ngoài danh sách gửi model).
  const docImageIds=docAssignedImageIds(docs, catalog);
  push(docImageIds.map(id=>byId.get(id)).filter(Boolean));
  push(imageScores(catalog, String(query ?? '').slice(0,1200)));
  if(ranked.length < limit) {
    const terms=[caption, ...arr(docs).flatMap(d=>[d.title, ...arr(d.keywords)])].filter(Boolean).join(' ');
    if(String(terms).trim()) push(imageScores(catalog, String(terms).slice(0,1200)));
  }
  const blocked=new Set(arr(exclude).map(String));
  // Ảnh vừa dùng ở bài trước bị đẩy xuống cuối, chỉ quay lại khi chủ đề không còn
  // đủ ảnh mới: bài cùng sản phẩm đăng lại không được lặp y nguyên bộ ảnh cũ.
  // NHƯNG ảnh do tài liệu KB gán cho mặt hàng (dòng "Ảnh:") giữ nguyên thứ tự ưu
  // tiên: mặt hàng thường chỉ có 2-3 ảnh, đẩy chúng xuống cuối là mất luôn ảnh đúng
  // (ca thật 15/10/2026: bài tôm thẻ bị gán ảnh đùi gà, đuôi heo vì 3 ảnh tôm vừa
  // dùng ở bài trước bị loại khỏi danh sách gửi model).
  const docIds=new Set(docImageIds);
  const docRanked=ranked.filter(i=>docIds.has(i.id));
  const kwRanked=ranked.filter(i=>!docIds.has(i.id));
  const ordered=[
    ...docRanked.filter(i=>!blocked.has(i.id)), ...docRanked.filter(i=>blocked.has(i.id)),
    ...kwRanked.filter(i=>!blocked.has(i.id)), ...kwRanked.filter(i=>blocked.has(i.id))
  ];
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
  const hotlineFixed=normalizeHotlineLine(draft.caption);
  if(hotlineFixed.changed) draft.caption=hotlineFixed.caption;
  const freshFixed=stripFreshClaimForCooked(draft.caption);
  if(freshFixed.removed.length) {
    draft.caption=freshFixed.caption;
    draft.risk_flags=[...new Set([...draft.risk_flags,'fresh_claim_removed_for_cooked_item'])].slice(0,20);
  }
  const priceStripped=stripPriceLines(draft.caption);
  if(priceStripped.removed.length) {
    if(priceStripped.caption) draft.caption=priceStripped.caption;
    draft.risk_flags=[...new Set([...draft.risk_flags,'price_line_removed'])].slice(0,20);
  }
  const danglingFixed=stripDanglingQuestions(draft.caption);
  if(danglingFixed.removed.length) {
    draft.caption=danglingFixed.caption;
    draft.risk_flags=[...new Set([...draft.risk_flags,'dangling_question_removed'])].slice(0,20);
  }
  const sourceIds=new Set(docs.map(d=>d.id));
  for(const id of draft.source_ids) if(!sourceIds.has(id)) throw new Error(`Unknown marketing source: ${id}`);
  const imageIds=new Set(images.map(i=>i.id));
  // Ảnh ngoài danh sách gửi model thì bỏ và ghi cờ, không ném lỗi: model hay copy
  // id ảnh từ dòng "Ảnh:" của tài liệu trong prompt, và trước đây chỉ vì một id
  // như vậy mà cả bài không tạo được (ca thật 15/10/2026, draft gấu bò).
  // Ảnh hàng khác vẫn không được đăng: id lạ bị loại, ensureMinMedia bù ảnh đúng chủ đề.
  const strayImages=draft.media.filter(m=>m?.type==='image' && m.image_id && !imageIds.has(m.image_id)).map(m=>String(m.image_id));
  if(strayImages.length) {
    draft.media=draft.media.filter(m=>!(m?.type==='image' && m.image_id && !imageIds.has(m.image_id)));
    draft.risk_flags=[...new Set([...draft.risk_flags,'image_id_not_in_shortlist'])].slice(0,20);
  }
  return draft;
}
// Chủ Page chốt 15/10/2026: bài đăng KHÔNG để giá, giá chỉ tư vấn khi khách inbox.
// Model vẫn có thể chép giá từ tài liệu KB, nên cắt hẳn dòng có giá trước khi lưu và
// ghi cờ price_line_removed để người duyệt biết bài đã bị lược.
const PRICE_LINE=/(\d[\d.,]*\s*(đ|₫|vnd|vnđ|đồng)\b)|(\bgiá\s*(lẻ|buôn|sỉ|bán)\b)|(\bgiá\s*[:=])/i;
export function stripPriceLines(caption) {
  const lines=String(caption??'').split('\n');
  const kept=[], removed=[];
  for(const line of lines) (PRICE_LINE.test(line) ? removed : kept).push(line);
  return {
    caption: kept.join('\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]+$/gm,'').trim(),
    removed: removed.map(l=>l.trim()).filter(Boolean)
  };
}
// Chủ Page chốt định dạng hotline: "📞 Hotline: 0976778755 và 0962365073". Model hay
// chèn gạch ngang/gạch dài giữa 2 số, chuẩn hoá lại cho đúng.
export function normalizeHotlineLine(caption) {
  let changed=false;
  const out=String(caption??'').split('\n').map(line=>{
    if(!/hotline/i.test(line)) return line;
    const nums=line.match(/(?:\+?84|0)\d{8,10}/g);
    if(!nums || nums.length<2) return line;
    const prefix=line.slice(0,line.indexOf(nums[0])).replace(/[\s:–—\-/]+$/,'').trim();
    const rebuilt=prefix+': '+nums.join(' và ');
    if(rebuilt!==line.trim()) changed=true;
    return rebuilt;
  });
  return {caption:out.join('\n'),changed};
}
// Hàng đã hấp/chín sẵn (ví dụ tôm thẻ hấp) không được nói "tươi sống" — chủ Page
// chốt 16/10/2026. Model vẫn chép câu so sánh với hàng tươi sống từ tài liệu chung,
// nên cắt hẳn dòng đó trước khi lưu và ghi cờ cho người duyệt.
const COOKED_ITEM=/(hấp chín|đã hấp|thẻ hấp|hấp sẵn|hàng chín)/i;
const FRESH_CLAIM=/(tươi sống|hàng tươi|như hàng tươi|tươi như)/i;
export function stripFreshClaimForCooked(caption) {
  const text=String(caption??'');
  // Dòng hỏi kiểu "hàng đông lạnh hay hàng chín?" không phải lời khẳng định hàng
  // chín: ca thật 17/10/2026, nháp mực ống (hàng sống cấp đông) bị cắt mất câu so
  // sánh chất lượng chỉ vì bài có câu hỏi nhắc chữ "hàng chín".
  const asserted=text.split('\n').filter(l=>!l.trim().endsWith('?')).join('\n');
  if(!COOKED_ITEM.test(asserted) || !FRESH_CLAIM.test(text)) return {caption:text,removed:[]};
  const kept=[], removed=[];
  for(const line of text.split('\n')) (FRESH_CLAIM.test(line)?removed:kept).push(line);
  const cleaned=kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  return cleaned ? {caption:cleaned, removed:removed.map(l=>l.trim()).filter(Boolean)} : {caption:text, removed:[]};
}
// Câu hỏi trong bài phải có câu trả lời ngay dưới (dòng bắt đầu bằng mũi tên).
// Nháp mực ống 17/10/2026 để "❓ Rã đông có mất vị không?" rồi không đáp, đọc như
// bài dở. Bỏ câu hỏi trống thay vì đăng câu hỏi không có câu trả lời.
const QUESTION_LINE=/❓/;
const ANSWER_LINE=/^(→|->|➜|=>|✔|✅|•|-|\*)/;
export function stripDanglingQuestions(caption) {
  const text=String(caption??'');
  const lines=text.split('\n');
  const kept=[], removed=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(!QUESTION_LINE.test(line) || line.trim().length>160) { kept.push(line); continue; }
    let j=i+1; while(j<lines.length && !lines[j].trim()) j++;
    if(ANSWER_LINE.test((lines[j]??'').trim())) kept.push(line); else removed.push(line.trim());
  }
  if(!removed.length) return {caption:text,removed:[]};
  const cleaned=kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  return cleaned ? {caption:cleaned,removed} : {caption:text,removed:[]};
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
  // Bộ chọn chủ đề phải thấy hết sản phẩm trong KB (nếu cắt bớt thì sản phẩm thêm
  // sau không bao giờ được chọn); content rút ngắn vì bài viết lấy facts từ tài liệu
  // đầy đủ ở bước sau, không lấy từ candidate.
  return docs.filter(isProductishDoc).slice(0,80).map(d=>{
    const text=normalize(`${d.title} ${arr(d.keywords).join(' ')} ${d.content}`);
    const hasImage=arr(d.keywords).some(k=>imageText.includes(normalize(k))) || imageText.includes(normalize(d.title));
    const recentlyPosted=arr(d.keywords).some(k=>normalize(k).length>=4 && recentText.includes(normalize(k)));
    return {id:d.id,title:d.title,keywords:arr(d.keywords).slice(0,12),hasImage,recentlyPosted,content:String(d.content).slice(0,300)};
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
// Năm dạng bài luân phiên. Chủ Page chốt 17/10/2026 sau khi các bài đăng bị khuân
// mẫu giống nhau (đo được 7/13 dòng trùng nguyên văn giữa 2 bài liền nhau).
export const POST_ANGLES = [
  {id:'mon-cach-dung', name:'Món và cách dùng', positioning:true, brief:'Kể 2-4 món hoặc cách chế biến THẬT có trong tài liệu và nói món đó hợp với ai. Nếu tài liệu không ghi món cụ thể thì chuyển sang nói cách dùng/nhóm khách phù hợp, KHÔNG tự nghĩ ra món.'},
  {id:'hoi-dap', name:'Hỏi đáp khách hay hỏi', positioning:false, brief:'Viết như đang trả lời một câu hỏi khách hay hỏi về mặt hàng này (quy cách đóng gói, hàng đông lạnh hay hàng chín, cách rã đông và bảo quản, dùng cho việc gì) và trả lời gọn bằng dữ kiện trong tài liệu. Mỗi câu hỏi PHẢI có dòng trả lời ngay dưới (bắt đầu bằng →); điều gì tài liệu không trả lời được thì KHÔNG hỏi, không để câu hỏi trống.'},
  {id:'chon-hang-theo-nhu-cau', name:'Chọn hàng theo nhu cầu', positioning:true, brief:'Nói từng nhóm nhu cầu (bếp ăn công nghiệp, nhà hàng, quán lẩu nướng, khách mua về dùng) cần gì ở mặt hàng này và vì sao phù hợp, dùng 2-4 gạch đầu dòng ngắn cho từng nhóm.'},
  {id:'ngan-gon', name:'Ngắn gọn', positioning:false, brief:'Bài ngắn 3-5 dòng như tin nhắn bán hàng: 1 dòng tên hàng và đặc điểm chính, 1 dòng khách phù hợp, 1 dòng CTA. Không tiêu đề in hoa, không gạch đầu dòng, tối đa 2 emoji.'},
  {id:'kho-hang', name:'Kho hàng và bảo quản', positioning:false, brief:'Kể chuyện hàng về kho/theo đợt: nhập từ đâu, đóng thùng ra sao, cách bảo quản và mẹo rã đông đúng cách, kèm 1-2 lưu ý khi dùng. Chỉ nêu dữ kiện có trong tài liệu.'}
];
// Tỉ lệ dòng trùng tối đa cho phép giữa bài mới và 3 bài gần nhất; vượt ngưỡng thì
// hệ thống tự viết lại bằng dạng khác (chủ Page chốt ngưỡng 40% ngày 17/10/2026).
export const REPEAT_MAX_RATIO = 0.4;
const ANGLE_META_KEY = 'marketing.recent_angles';
export function pickAngle(recentAngles=[], {exclude=[]}={}) {
  const used=arr(recentAngles).map(String);
  const blocked=new Set(arr(exclude).map(String));
  const last=POST_ANGLES.findIndex(a=>a.id===String(used[0] ?? ''));
  const start=last<0 ? 0 : (last+1)%POST_ANGLES.length;
  const rr=POST_ANGLES.map((_,k)=>POST_ANGLES[(start+k)%POST_ANGLES.length]);
  // Ưu tiên dạng chưa dùng trong 3 bài gần nhất rồi mới nới ra 2 bài: với 3 bài
  // liên tiếp mà chỉ né 2 bài thì bài thứ 4 lặp lại y dạng của bài đầu (mà 5 dạng
  // thì thừa chỗ để khác nhau).
  for(const depth of [3,2,0]) {
    const recent=new Set(used.slice(0,depth));
    const free=rr.filter(a=>!recent.has(a.id) && !blocked.has(a.id));
    if(free.length) return free[0];
  }
  return rr[0];
}
// Dòng bắt buộc theo chính sách (hotline + CTA) bị loại khỏi phép đo: bài nào cũng
// phải có, tính vào sẽ khiến mọi bài ngắn bị coi là trùng khung.
const MANDATORY_LINE=/(hotline|inbox|comment|liên hệ|tư vấn)/;
function captionLines(text) {
  return String(text ?? '').split('\n')
    .map(l=>l.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' '))
    .filter(l=>l.length>=3 && !MANDATORY_LINE.test(l));
}
// Tỉ lệ dòng KHÔNG bắt buộc trùng nhau giữa bài mới và một bài cũ (0..1). Hai bài
// chỉ khác tên hàng thường trùng trên 40% số dòng; đây là rào phát hiện khuân mẫu.
export function captionRepeatRatio(caption,others=[]) {
  const mine=captionLines(caption);
  let worst={ratio:0,shared:0,lines:mine.length,withId:null};
  if(mine.length<2) return worst;
  for(const other of arr(others)) {
    const id=typeof other==='string' ? null : (other?.id ?? null);
    const their=captionLines(typeof other==='string' ? other : other?.caption);
    if(their.length<2) continue;
    const set=new Set(their);
    const shared=mine.filter(l=>set.has(l)).length;
    const ratio=shared/Math.min(mine.length,their.length);
    if(ratio>worst.ratio) worst={ratio,shared,lines:Math.min(mine.length,their.length),withId:id};
  }
  return worst;
}
function marketingPrompt(config,{prompt,tone,scheduledAt,feedback='',stylePosts=[],angle=POST_ANGLES[0]},docs,images) {
  return `Bạn viết bài Facebook cho Page ${config.pageName}. Style ưu tiên là bài bán hàng Facebook như mẫu TM Food: nhìn vào là thấy sản phẩm, món dùng được, khách hàng phù hợp, lợi ích mua sỉ/lẻ và cách liên hệ. Không viết kiểu đoạn văn blog.

Chỉ dùng dữ liệu nội bộ đã duyệt và yêu cầu của admin. Không bịa giá, tồn kho, khuyến mãi, chứng nhận, chính sách, số điện thoại hoặc cam kết chất lượng. Nếu thiếu dữ kiện, bỏ dòng đó hoặc dùng inbox/comment thay cho hotline.

Trả JSON duy nhất với keys title_internal, caption, hashtags, cta, media, link, scheduled_at_hint, source_ids, risk_flags, confidence.

QUY TẮC CAPTION (bắt buộc). Mỗi bài viết theo ĐÚNG MỘT dạng bài dưới đây:
DẠNG BÀI HÔM NAY: "${angle.name}" - ${angle.brief}

Bài phải đọc như một bài mới, KHÔNG khuân lại một khuôn. Không phải bài nào cũng "tiêu đề IN HOA -> đoạn 🔥 -> block ✅ -> dòng 💯 ${config.pageName} - nguồn hàng... -> gạch đầu dòng ✔ -> hotline": chỉ dùng những khối đó khi dạng bài cần, và câu mở bài/cách xuống dòng/độ dài phải khác bài gần nhất.
1. Dòng đầu là câu mở cụ thể, gọn dưới 140 ký tự, nêu đúng sản phẩm; không mở bằng "ngày nay / bạn đang tìm kiếm" và không mở bằng câu hỏi rồi tự trả lời. Dạng "Ngắn gọn" không in hoa cả dòng.
2. Mỗi dòng 1 ý, xuống dòng thoáng, không viết đoạn văn dài kiểu blog. Độ dài theo dạng: dạng "Ngắn gọn" 3-5 dòng, các dạng khác 6-14 dòng.
3. Chỉ dùng dữ kiện có trong tài liệu: sản phẩm, xuất xứ/thương hiệu, quy cách, nhóm khách, món/cách chế biến, bảo quản. Thiếu dữ kiện thì bỏ ý đó, không suy đoán và không mượn dữ kiện của mặt hàng khác.
4. Emoji đúng sản phẩm, tiết chế theo mặt hàng (dạng "Ngắn gọn" tối đa 2 emoji). Không rải emoji mỗi dòng cho đủ.
5. Dòng định vị "💯 ${config.pageName} - ..." CHỈ được dùng ở dạng "Món và cách dùng" và "Chọn hàng theo nhu cầu". Các dạng khác KHÔNG dùng dòng này.
6. Nhóm khách/hoàn cảnh dùng nêu tự nhiên theo dạng, không lặp y nguyên cùng một danh sách "Bếp ăn / Nhà hàng / Khách sạn / Quán lẩu nướng" ở mọi bài.
7. CTA cuối: nếu tài liệu có hotline thì BẮT BUỘC thêm dòng "📞 Hotline: <đủ các số trong tài liệu>" (giữ nguyên số, không rút gọn, không thêm số khác; giữa 2 số dùng chữ "và", không dùng gạch ngang/gạch dài), rồi tới dòng "💬 Inbox/comment để được tư vấn". Nếu tài liệu không có số thì dùng "📞 Liên hệ ${config.pageName} để nhận báo giá/tư vấn" hoặc "💬 Inbox/comment để được tư vấn".
8. Hashtags: trả về 4-6 cụm từ khoá ngắn, KHÔNG dấu, KHÔNG ký tự # (ví dụ: "bap hoa bo", "thit bo nhap khau", "thuc pham dong lanh"). Hệ thống tự ghép thành hashtag chuẩn.
9. Ảnh: danh sách "Ảnh liên quan" bên dưới ĐÃ ĐƯỢC LỌC theo chủ đề. Chọn TỐI THIỂU 3 ảnh (tối đa 6) nếu danh sách có từ 3 ảnh, xếp theo thứ tự muốn đăng, chỉ dùng image_id trong danh sách đó: media [{"type":"image","image_id":"..."}]. Chỉ khi danh sách dưới 3 ảnh mới lấy hết và thêm risk_flags "fewer_images_than_min".

Cách viết cho ra bài đẹp:
- Được dùng emoji chức năng giống mẫu: 🥩 🔥 ✅ 🍲 🍛 🍜 💯 ✔ 📞 ☎ 💬. Emoji phải đúng sản phẩm (gà thì 🐔/🍗, heo 🐷, bò 🥩, cá 🐟, hải sản 🦐/🐙) và giúp quét nội dung, không rải lung tung.
- Dùng bullet/list ngắn, dễ nhìn trên Facebook. Mỗi dòng 1 ý.
- Từ ngữ bán hàng được phép tự nhiên: giòn ngon, sần sật, thơm, béo, ngọt, tiện, đa dạng món nếu phù hợp với KB/sản phẩm. Không nói "tươi", "sạch", "cao cấp", "cam kết", "100%" nếu không có nguồn.
- Dòng tiêu đề và hashtag phải làm rõ sản phẩm; không viết chung chung "thực phẩm chất lượng".
- Hàng ĐÃ HẤP/CHÍN sẵn (ví dụ tôm thẻ hấp): viết rõ là hàng hấp chín, rã đông là dùng được ngay; KHÔNG viết "tươi sống" hay "giữ như hàng tươi sống" cho hàng chín.
- Bài luôn cần ảnh: ít nhất 3 ảnh khi danh sách ảnh liên quan có đủ, và ảnh phải đúng sản phẩm đang nói (không lấy ảnh hàng khác cho đủ số).

Cấm hẳn (bài sẽ bị chấm điểm thấp nếu vi phạm):
- Từ sáo AI/quảng cáo: nâng tầm, giải pháp, đẳng cấp, hoàn hảo, tuyệt vời, hàng đầu, số 1, đỉnh/đỉnh cao, trọn vẹn, tận hưởng, chất lượng vượt trội.
- Dấu gạch dài "—" (không dùng; dấu "–" trong dòng tiêu đề thì được vì Page đang dùng), dấu chấm than chồng, mở bài "ngày nay/bạn đang tìm kiếm", kết "tóm lại/kết luận".
- Mẫu "không chỉ ... mà còn", "từ A đến B", CTA thúc ép "nhanh tay/đừng bỏ lỡ/hãy liên hệ ngay hôm nay".
- KHÔNG đưa BẤT KỲ giá nào vào bài đăng: không số tiền (đ/kg, đ/thùng, VND), không "giá buôn/giá lẻ/giá sỉ", không mốc số lượng kèm giá, kể cả khi tài liệu có ghi giá. Giá chỉ tư vấn khi khách inbox. Tài liệu có giá thì thay bằng đặc điểm, quy cách, đối tượng khách dùng.
- Bịa tồn kho, khuyến mãi, số điện thoại ngoài hotline trong tài liệu, chứng nhận, giao hàng, hàng sẵn, hỗ trợ cắt, bảo hành/cam kết nếu dữ liệu không nói rõ.

Tự chấm trước khi trả lời: không ảnh tối đa 6/10; thiếu dữ kiện sản phẩm tối đa 5/10; thiếu block chế biến/checklist/CTA thì viết lại; còn mùi AI thì viết lại.

Tone: ${tone || config.marketing?.defaultTone || 'bán hàng Facebook rõ ý, gọn, đẹp như bài mẫu TM Food'}
Yêu cầu admin: ${prompt}
Lịch gợi ý: ${scheduledAt || ''}${feedback ? `\n\nBẢN TRƯỚC CHƯA ĐẠT, phải viết lại:\n${feedback}` : ''}
Bài Page đã đăng để học style (CHỈ học format/giọng văn/hashtag, KHÔNG lấy facts): ${JSON.stringify(recentPostStyle(stylePosts).slice(0,8))}
Tài liệu đã duyệt: ${JSON.stringify(docPayload(docs))}
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

function readRecentAngles(store) {
  try { const raw=store.getMeta ? store.getMeta(ANGLE_META_KEY) : null; return arr(raw?JSON.parse(raw):[]).map(String).slice(0,5); }
  catch { return []; }
}
function writeRecentAngles(store,list) {
  try { store.setMeta?.(ANGLE_META_KEY,JSON.stringify(arr(list).map(String).slice(0,5))); } catch {}
}
export function createMarketing(config,store,complete,meta,{setIntervalFn=setInterval,clearIntervalFn=clearInterval,notifier=null}={}) {
  // Viết bài, chấm điểm, và nếu dưới ngưỡng thì viết lại (tối đa reviseAttempts
  // lần) với phản hồi nêu đúng lỗi cần sửa. Chỉ giữ bản điểm cao nhất.
  async function generateDraft({prompt='',tone='',scheduledAt=0,stylePosts=[],sourceIds=null,excludeImageIds=[],imageQuery='',angle=POST_ANGLES[0],recentCaptions=[],recentAngles=[]}) {
    const allDocs=approvedDocs(config.knowledgeFile), allImages=approvedImages(config.imageCatalogFile);
    const allowed=new Set(arr(sourceIds));
    const docs=withContactDocs(allowed.size ? allDocs.filter(d=>allowed.has(d.id)) : allDocs, allDocs);
    // Truy vấn chọn ảnh phải là chủ đề + mặt hàng (sạch), không phải cả brief kèm
    // JSON tài liệu KB: brief dài làm ảnh sản phẩm khác lọt vào danh sách gửi model.
    const shortlist=selectPostImages(config,{query:String(imageQuery||prompt),docs,exclude:excludeImageIds});
    const images=shortlist.length ? shortlist : allImages;
    const minScore=Number(config.marketing?.minScore??0);
    const reviseAttempts=minScore>0?Math.max(0,Number(config.marketing?.reviseAttempts??0)):0;
    // Số lượt: lượt đầu + số lượt sửa theo điểm SEO + 1 lượt cho rào chống lặp khung.
    const maxAttempts=1+reviseAttempts+1;
    let best=null, bestSeo=null, bestRepeat=null, bestAngle=angle;
    let current=angle; const tried=[]; let lastError=null;
    for(let attempt=0; attempt<maxAttempts; attempt++) {
      const seoFeedback=attempt!==0 && minScore>0 && bestSeo && bestSeo.score<minScore ? [
        `Bản trước bị chấm ${bestSeo.score}/10, dưới ngưỡng ${minScore}/10.`,
        bestSeo.notes.length?`Lỗi cần sửa: ${bestSeo.notes.join('; ')}.`:'',
        'Viết lại hoàn toàn, giữ đúng dữ kiện KB, không thêm số liệu hay cam kết mới.'
      ].filter(Boolean).join(' ') : '';
      const repeatFeedback=attempt!==0 && bestRepeat && bestRepeat.ratio>=REPEAT_MAX_RATIO ? [
        `Bản trước trùng ${Math.round(bestRepeat.ratio*100)}% số dòng với một bài vừa đăng/vừa soạn (bài: ${bestRepeat.withId ?? 'gần nhất'}).`,
        `Viết lại theo dạng "${current.name}" với câu mở bài, cách trình bày và độ dài KHÁC HẲN, không dùng lại các dòng đã có ở bài đó.`
      ].join(' ') : '';
      const feedback=[seoFeedback,repeatFeedback].filter(Boolean).join(' ');
      let draft;
      try {
        const text=await complete({agentId:config.agentId,message:marketingPrompt(config,{prompt,tone,scheduledAt,feedback,stylePosts,angle:current},docs,images),system:'Bạn viết bài Facebook marketing và chỉ trả JSON.',timeoutMs:config.agentTimeoutMs});
        draft=validateDraft(parseModelJson(text),{docs,images,config,topic:prompt});
      } catch(err) {
        // Model trả JSON hỏng hoặc thiếu key bắt buộc thì thử lại, đừng bỏ cả bài:
        // 18/10/2026 cron 9:00 chết hẳn vì "Expected property name or '}' in JSON".
        lastError=err;
        continue;
      }
      const seo=scoreMarketingSeo(draft);
      const repeat=captionRepeatRatio(draft.caption,recentCaptions);
      const seoOk=minScore<=0 || seo.score>=minScore;
      const repeatOk=repeat.ratio<REPEAT_MAX_RATIO;
      if(seoOk && repeatOk) { best=draft; bestSeo=seo; bestRepeat=repeat; bestAngle=current; break; }
      if(!best || seo.score>bestSeo.score) { best=draft; bestSeo=seo; bestRepeat=repeat; bestAngle=current; }
      if(!repeatOk) { tried.push(current.id); current=pickAngle(recentAngles,{exclude:tried}); }
    }
    if(!best) throw lastError ?? new Error('marketing draft failed');
    return {draft:best,seo:bestSeo,minScore,angle:bestAngle,repeat:bestRepeat};
  }
  async function createDraft({prompt='',tone='',scheduledAt=0,approvedBy='admin',stylePosts=[],sourceIds=null,excludeImageIds=[],imageQuery=''}={}) {
    if(!config.marketing?.enabled) throw new Error('marketing disabled');
    const minImages=Math.max(1,Number(config.marketing?.minImagesPerPost??3));
    const maxImages=6;
    const recentPosts=arr(store.listMarketingPosts({limit:10}));
    const alreadyUsed=recentPosts
      .flatMap(p=>arr(JSON.parse(p.media||'[]')).map(m=>m?.image_id)).filter(Boolean).map(String);
    // Rào chống khuân mẫu: so với 3 bài gần nhất; trùng >=40% số dòng thì viết lại
    // bằng dạng khác (chủ Page chốt 17/10/2026).
    const recentCaptions=recentPosts.filter(p=>p.status!=='deleted' && p.caption).slice(0,3)
      .map(p=>({id:String(p.id).slice(0,8),caption:p.caption}));
    const recentAngles=readRecentAngles(store);
    const angle=pickAngle(recentAngles);
    const exclude=[...new Set([...arr(excludeImageIds).map(String), ...alreadyUsed])];
    const imageQueryText=String(imageQuery||prompt);
    const {draft,seo,minScore,angle:usedAngle,repeat}=await generateDraft({prompt,tone,scheduledAt,stylePosts,sourceIds,excludeImageIds:exclude,imageQuery:imageQueryText,angle,recentCaptions,recentAngles});
    const selected=arr(sourceIds).length ? approvedDocs(config.knowledgeFile).filter(d=>sourceIds.includes(d.id)) : [];
    const shortlist=selectPostImages(config,{query:imageQueryText,caption:draft.caption,docs:selected,exclude});
    // Tài liệu gán đủ ảnh cho mặt hàng thì bài dùng đúng bộ ảnh đó, không để model
    // chọn ảnh hàng khác (ca thật 15/10/2026: bài tôm thẻ bị gán ảnh đùi gà, đuôi heo).
    const preferred=docAssignedImageIds(selected,shortlist).slice(0,maxImages);
    const picked=preferred.length>=minImages ? preferred.map(id=>({type:'image',image_id:id})) : draft.media;
    const {media,enough}=ensureMinMedia(picked,shortlist,{min:minImages,max:maxImages});
    draft.media=media;
    draft.risk_flags=draft.risk_flags.filter(f=>f!=='no_approved_image_available' && f!=='fewer_images_than_min');
    if(!enough) draft.risk_flags=[...new Set([...draft.risk_flags,'fewer_images_than_min'])];
    const below=minScore>0 && seo.score<minScore;
    const repeated=repeat && repeat.ratio>=REPEAT_MAX_RATIO;
    const riskFlags=[...new Set([
      ...draft.risk_flags,
      ...(below?[`low_seo_score_${seo.score}`]:[]),
      ...(repeated?[`template_repeat_${Math.round(repeat.ratio*100)}pct`]:[])
    ])];
    writeRecentAngles(store,[usedAngle.id,...recentAngles]);
    const post=store.createMarketingPost({...draft,risk_flags:riskFlags,topic:prompt});
    // lowScoreAction=hold: bài dưới ngưỡng không được đẩy lên Telegram, chỉ nằm
    // trong admin UI để chủ Page tự xem/sửa.
    const hold=below && config.marketing?.lowScoreAction==='hold';
    if(!hold) { try { await notifier?.notifyMarketingPreview?.(post); } catch {} }
    return hold ? {...post,held:true,seo} : post;
  }
  async function createAutoDraft({instruction='',tone='',scheduledAt=0,approvedBy='admin'}={}) {
    if(!config.marketing?.enabled) throw new Error('marketing disabled');
    const docs=approvedDocs(config.knowledgeFile), images=approvedImages(config.imageCatalogFile, Infinity);
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
    const selectedDocs=withContactDocs(sourceIds.length?docs.filter(d=>sourceIds.includes(d.id)):[], docs);
    const prompt=[
      `AUTO_TOPIC: ${String(chosen.topic??'').slice(0,200)}`,
      instruction?`Yêu cầu admin: ${String(instruction).slice(0,500)}`:'',
      'Viết bài CHỈ từ các source_ids đã chọn bên dưới. Bỏ qua mọi facts nằm trong bài đã đăng cũ hoặc trong lý do chọn nếu không xuất hiện trong KB.',
      sourceIds.length?`source_ids đã chọn: ${sourceIds.join(', ')}`:'',
      selectedDocs.length?`KB được phép dùng: ${JSON.stringify(selectedDocs.map(d=>({id:d.id,title:d.title,content:String(d.content).slice(0,1000)})))}`:'',
      String(chosen.reason??'')?`Lý do chọn topic (không phải nguồn facts): ${String(chosen.reason).slice(0,300)}`:''
    ].filter(Boolean).join('\n');
    const productTerms=selectedDocs.map(d=>String(d.title??'').trim()).filter(Boolean).slice(0,4).join(' ');
    const imageQuery=[String(chosen.topic??'').trim(), String(instruction).trim(), productTerms].filter(Boolean).join(' ').slice(0,600);
    return createDraft({prompt,tone:tone||chosen.tone||'bán hàng Facebook giống bài đã đăng của TM Food',scheduledAt,approvedBy,stylePosts,sourceIds,imageQuery});
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
  // Xoá bài đã đăng trên Page theo yêu cầu chủ Page. Đi qua admin API của service
  // (cổng duyệt nằm trong service), không gọi thẳng Graph từ phía agent.
  async function deletePost(id) {
    if(config.mode!=='live') throw new Error('draft mode blocks marketing delete');
    const current=store.marketingPost(id);
    if(!current) throw new Error('Marketing post not found');
    if(current.status!=='published') throw new Error('Only a published post can be deleted');
    if(!current.facebook_post_id) throw new Error('Marketing post has no Facebook id');
    await meta.deletePost(current.facebook_post_id);
    return store.markMarketingDeleted(id,'operator_deleted');
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
  return {createDraft,createAutoDraft,publishNow,deletePost,tick,recoverStalePublishing,start,permissions,validateDraft};
}

export { validateDraft, scoreMarketingSeo };
