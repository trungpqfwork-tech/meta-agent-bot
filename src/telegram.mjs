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

export function telegramNotifier(config, secrets, fetcher = fetch) {
  const token = secrets.TELEGRAM_BOT_TOKEN;
  const chatIds = Array.isArray(config.orderTelegramChatIds) ? config.orderTelegramChatIds : [];
  const enabled = Boolean(token && chatIds.length);
  async function broadcast(text) {
    let sent = 0;
    for (const chatId of chatIds) {
      const r = await fetcher(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({chat_id: chatId, text, disable_web_page_preview: true})
      });
      if (!r.ok) throw new Error(`Telegram notify failed for chat ${chatId}`);
      sent++;
    }
    return sent;
  }
  return {
    enabled,
    async notifyOrder(order) {
      if (!enabled) return 0;
      return broadcast(formatOrderMessage(config, order));
    },
    async notifyHandoff(info) {
      if (!enabled) return 0;
      return broadcast(formatHandoffMessage(config, info));
    }
  };
}
