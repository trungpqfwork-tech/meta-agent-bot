import { scoreMarketingSeo, detectAiTells } from './seoscore.mjs';
export { scoreMarketingSeo, detectAiTells };

function labelCustomerType(value) {
  if (value === 'store') return 'Cửa hàng/đại lý/quán';
  if (value === 'personal') return 'Cá nhân/gia đình';
  return 'Chưa rõ';
}

export function formatOrderMessage(config, order) {
  const products = Array.isArray(order.products) && order.products.length
    ? order.products.map(x => `- ${x}`).join('\n')
    : '- Chưa rõ';
  return [
    `Đơn hàng mới - ${config.pageName}`,
    '',
    `Khách: ${order.customer_name || 'Chưa rõ'}`,
    `Loại khách: ${labelCustomerType(order.customer_type)}`,
    `Số điện thoại: ${order.phone || 'Chưa rõ'}`,
    `Địa chỉ: ${order.address || 'Chưa rõ'}`,
    'Sản phẩm:',
    products,
    '',
    `PSID: ${order.psid}`,
    `Thời gian: ${new Date().toISOString()}`
  ].join('\n');
}

export function formatHandoffMessage(config, info) {
  const messages = Array.isArray(info.messages) && info.messages.length
    ? info.messages.map(x => `- ${x}`).join('\n')
    : '- Chưa rõ';
  return [
    `Cần tư vấn viên hỗ trợ - ${config.pageName}`,
    '',
    `Khách: ${info.customerName || 'Chưa rõ tên'}`,
    `Số điện thoại: ${info.phone || 'Chưa rõ'}`,
    `Lý do chuyển: ${info.reason || 'Chưa rõ'}`,
    'Tin nhắn gần nhất của khách:',
    messages,
    '',
    `PSID: ${info.psid}`,
    `Mở hội thoại: https://www.facebook.com/messages/t/${info.psid}`,
    `Thời gian: ${new Date().toISOString()}`
  ].join('\n');
}

// Row từ SQLite lưu hashtags/media dạng chuỗi JSON, còn draft gọi trực tiếp lại là
// mảng. Chuẩn hoá ở đây để preview không báo "CHƯA CÓ" và không mất điểm hashtag.
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

export function formatMarketingPreviewMessage(config, post) {
  const normalized = {...post, hashtags: parseList(post.hashtags), media: parseList(post.media)};
  const seo = scoreMarketingSeo(normalized);
  const minScore = Number(config?.marketing?.minScore ?? 0);
  const below = minScore > 0 && seo.score < minScore;
  const hashtags = normalized.hashtags.length ? normalized.hashtags.join(' ') : 'Chưa có';
  const media = normalized.media.length ? normalized.media.map(m => m.image_id || m.url || m.filePath || 'ảnh').join(', ') : 'Chưa có ảnh đã duyệt';
  const hashtagLine = normalized.hashtags.length
    ? `Hashtag (gắn vào cuối bài khi đăng): ${hashtags}`
    : `Hashtag: CHƯA CÓ, đăng lên sẽ không có hashtag nào. Sửa bằng /editpost để model viết lại kèm hashtag.`;
  return [
    '[NHÁP FACEBOOK - CHƯA ĐĂNG]',
    `Page: ${config.pageName}`,
    `Bài: ${post.id}`,
    `Trạng thái: ${post.status ?? 'draft'}`,
    `SEO/social score: ${seo.score}/10${minScore > 0 ? ` (ngưỡng gửi: ${minScore}/10)` : ''}`,
    below ? `CẢNH BÁO: dưới ngưỡng ${minScore}/10, anh nên sửa trước khi duyệt.` : null,
    seo.notes.length ? `Cần cải thiện: ${seo.notes.join('; ')}` : 'Cần cải thiện: không có lỗi lớn',
    '',
    'Caption:',
    post.caption ?? '',
    '',
    hashtagLine,
    `Ảnh: ${media}`,
    '',
    'Cách sửa nhanh: gửi tin nhắn theo mẫu (hoặc bấm nút "Sửa" để nhận hướng dẫn):',
    `/editpost ${post.id} nội dung caption mới`,
    '',
    'Menu: Duyệt (chốt nội dung) · Đăng ngay (gọi Meta publish thật) · Hủy · Sửa.'
  ].filter(line => line !== null).join('\n');
}

function marketingKeyboard(id) {
  return {inline_keyboard:[
    [{text:'Duyệt',callback_data:`mk:approve:${id}`},{text:'Hủy',callback_data:`mk:cancel:${id}`}],
    [{text:'Đăng ngay',callback_data:`mk:publish:${id}`},{text:'Sửa: reply /editpost',callback_data:`mk:edit:${id}`}]
  ]};
}

function approvedKeyboard(id) {
  return {inline_keyboard:[
    [{text:'Đăng ngay',callback_data:`mk:publish:${id}`},{text:'Hủy',callback_data:`mk:cancel:${id}`}]
  ]};
}

const NO_KEYBOARD = {inline_keyboard: []};

async function callTelegram(token, method, body, fetcher) {
  const r = await fetcher(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = new Error(`Telegram ${method} failed`);
    err.apiError = true;
    try { err.description = (await r.json())?.description ?? ''; } catch { err.description = ''; }
    throw err;
  }
  return r.json ? r.json() : {};
}

export function telegramNotifier(config, secrets, fetcher = fetch) {
  const token = secrets.TELEGRAM_BOT_TOKEN || secrets.PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN;
  // Preview duyệt bài phải gửi bằng bot admin: bot dịch vụ (khách hàng) thường
  // không nằm trong chat của admin nên Telegram trả "chat not found".
  const adminToken = secrets.PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN || token;
  const chatIds = Array.isArray(config.orderTelegramChatIds) ? config.orderTelegramChatIds : [];
  const adminChatIds = Array.isArray(config.adminTelegramAllowedUsers) ? config.adminTelegramAllowedUsers : [];
  const enabled = Boolean(token && chatIds.length);
  async function broadcast(text, options = {}, ids = chatIds, useToken = token, tolerant = false) {
    let sent = 0;
    for (const chatId of ids) {
      if (tolerant) {
        // Preview duyệt bài: một chat lỗi (chưa /start bot, bot bị chặn) không được
        // làm hỏng cả lượt gửi cho các admin khác.
        try {
          await callTelegram(useToken, 'sendMessage', {chat_id: chatId, text, disable_web_page_preview: true, ...options}, fetcher);
          sent++;
        } catch { /* bỏ qua chat không gửi được */ }
        continue;
      }
      await callTelegram(useToken, 'sendMessage', {chat_id: chatId, text, disable_web_page_preview: true, ...options}, fetcher);
      sent++;
    }
    return sent;
  }
  return {
    enabled,
    marketingEnabled: Boolean(adminToken && adminChatIds.length),
    async notifyOrder(order) {
      if (!enabled) return 0;
      return broadcast(formatOrderMessage(config, order));
    },
    async notifyHandoff(info) {
      if (!enabled) return 0;
      return broadcast(formatHandoffMessage(config, info));
    },
    async notifyMarketingPreview(post) {
      if (!adminToken || !adminChatIds.length) return 0;
      return broadcast(formatMarketingPreviewMessage(config, post), {reply_markup: marketingKeyboard(post.id)}, adminChatIds, adminToken, true);
    }
  };
}

function allowed(config, from) {
  const ids = Array.isArray(config.adminTelegramAllowedUsers) ? config.adminTelegramAllowedUsers : [];
  return ids.includes(String(from?.id ?? ''));
}

async function answer(token, callbackQueryId, text, fetcher) {
  try { await callTelegram(token, 'answerCallbackQuery', {callback_query_id: callbackQueryId, text, show_alert: false}, fetcher); return true; }
  catch { return false; }
}

async function send(token, chatId, text, fetcher, replyMarkup) {
  return callTelegram(token, 'sendMessage', {chat_id: chatId, text, disable_web_page_preview: true, ...(replyMarkup ? {reply_markup: replyMarkup} : {})}, fetcher);
}

// Gửi phản hồi cho admin: thử bot admin trước (bot đã gửi preview), nếu Telegram
// từ chối thì thử bot dịch vụ. Lỗi mạng thì không thử lại để tránh gửi trùng.
async function sendToAdmin(primaryToken, fallbackToken, chatId, text, fetcher, replyMarkup) {
  const tokens = [primaryToken, fallbackToken].filter((t, i, a) => t && a.indexOf(t) === i);
  let lastError;
  for (const token of tokens) {
    try { return await send(token, chatId, text, fetcher, replyMarkup); }
    catch (e) { lastError = e; if (!e.apiError) throw e; }
  }
  throw lastError ?? new Error('telegram_send_failed');
}

async function clearButtons(token, chatId, messageId, fetcher, keyboard = NO_KEYBOARD) {
  if (!chatId || !messageId) return false;
  try { await callTelegram(token, 'editMessageReplyMarkup', {chat_id: chatId, message_id: messageId, reply_markup: keyboard}, fetcher); return true; }
  catch { return false; }
}

export async function handleTelegramMarketingUpdate(config, secrets, store, marketing, update, fetcher = fetch) {
  const token = secrets.TELEGRAM_BOT_TOKEN || secrets.PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN;
  const adminToken = secrets.PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN || token;
  if (!token) return {ok:false, reason:'telegram_token_missing'};
  if (update.callback_query) {
    const q = update.callback_query;
    if (!allowed(config, q.from)) return {ok:false, reason:'forbidden'};
    const [prefix, action, id] = String(q.data ?? '').split(':');
    if (prefix !== 'mk' || !id) return {ok:false, reason:'unknown_callback'};
    const chatId = q.message?.chat?.id;
    const messageId = q.message?.message_id;
    // Bấm nút phải luôn thấy phản hồi: toast (answerCallbackQuery) + tin nhắn
    // trong chat. Toast có thể hết hạn nên tin nhắn mới là phản hồi chính.
    const reply = async (toast, text, keyboard) => {
      await answer(adminToken, q.id, toast, fetcher) || await answer(token, q.id, toast, fetcher);
      if (chatId) {
        try { await sendToAdmin(adminToken, token, chatId, text, fetcher, keyboard); }
        catch (e) { return {ok:false, reason:'notify_failed', detail:String(e.description ?? e.message)}; }
      }
      return {ok:true, action};
    };
    try {
      if (action === 'approve') {
        const post = store.marketingPost(id);
        if (!post) return reply('Không tìm thấy nháp', `⚠️ Không tìm thấy nháp ${id}. Có thể nháp đã bị xóa.`);
        store.approveMarketingPost(id, String(q.from.id));
        const seo = scoreMarketingSeo({...post, hashtags: parseList(post.hashtags), media: parseList(post.media)});
        const result = await reply('Đã duyệt nháp', [
          `✅ Đã duyệt nháp ${id}`,
          `Trạng thái: approved · SEO/social ${seo.score}/10`,
          'Bấm "Đăng ngay" ở tin trên khi muốn đăng lên Page (nút Duyệt đã bỏ để tránh bấm lặp).'
        ].join('\n'), approvedKeyboard(id));
        await clearButtons(adminToken, chatId, messageId, fetcher, approvedKeyboard(id));
        return result;
      }
      if (action === 'cancel') {
        const post = store.marketingPost(id);
        if (!post) return reply('Không tìm thấy nháp', `⚠️ Không tìm thấy nháp ${id}. Có thể nháp đã bị xóa.`);
        store.cancelMarketingPost(id, 'telegram_cancelled');
        const result = await reply('Đã hủy nháp', `🚫 Đã hủy nháp ${id}. Không có gì được đăng lên Page.`);
        await clearButtons(adminToken, chatId, messageId, fetcher);
        return result;
      }
      if (action === 'publish') {
        const post = store.marketingPost(id);
        if (!post) return reply('Không tìm thấy nháp', `⚠️ Không tìm thấy nháp ${id}. Có thể nháp đã bị xóa.`);
        if (!post.approved_at || !['approved','failed','scheduled'].includes(post.status)) {
          return reply('Cần duyệt trước', `⚠️ Nháp ${id} đang ở trạng thái ${post.status}, chưa duyệt nên em không đăng. Bấm "Duyệt" trước rồi bấm "Đăng ngay".`, marketingKeyboard(id));
        }
        await answer(adminToken, q.id, 'Đang đăng lên Page...', fetcher) || await answer(token, q.id, 'Đang đăng lên Page...', fetcher);
        try {
          await marketing.publishNow(id, {quietHourOverride:true});
          const after = store.marketingPost(id);
          await clearButtons(adminToken, chatId, messageId, fetcher);
          return reply('Đã đăng', [
            `✅ Đã đăng lên Facebook Page${after?.facebook_post_id ? ` (${after.facebook_post_id})` : ''}`,
            after?.permalink_url ? `Link: ${after.permalink_url}` : 'Meta chưa trả permalink, mở Page để kiểm tra.'
          ].join('\n'));
        } catch (e) {
          return reply('Đăng lỗi', `❌ Đăng không thành công: ${String(e.message ?? e)}. Nháp giữ nguyên, sửa nội dung rồi bấm "Đăng ngay" lại.`, marketingKeyboard(id));
        }
      }
      if (action === 'edit') {
        const post = store.marketingPost(id);
        const caption = String(post?.caption ?? '');
        return reply('Đã gửi hướng dẫn sửa', [
          `Sửa bài ${id}`,
          'Copy dòng lệnh dưới đây, thay phần nội dung mới rồi gửi vào chat này:',
          `/editpost ${id} nội dung mới`,
          '',
          'Caption hiện tại:',
          caption || '(trống)'
        ].join('\n'), marketingKeyboard(id));
      }
      return reply('Nút không nhận diện được', `⚠️ Nút này không nhận diện được (action="${String(action ?? '')}"). Dùng menu trên tin nháp.`, marketingKeyboard(id));
    } catch (e) {
      return reply('Lỗi', `❌ Thao tác "${action}" thất bại: ${String(e.message ?? e)}. Nháp giữ nguyên.`, marketingKeyboard(id));
    }
  }
  const msg = update.message;
  if (!msg || !allowed(config, msg.from)) return {ok:false, reason:'ignored'};
  const text = String(msg.text ?? '').trim();
  const m = /^\/editpost\s+(\S+)\s+([\s\S]{20,5000})$/i.exec(text);
  if (!m) return {ok:false, reason:'unsupported_message'};
  const [, id, caption] = m;
  const post = store.updateMarketingPost(id, {caption});
  await send(token, msg.chat.id, formatMarketingPreviewMessage(config, post), fetcher, marketingKeyboard(id));
  return {ok:true, action:'edit'};
}
