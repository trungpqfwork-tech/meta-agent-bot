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

export function telegramNotifier(config, secrets, fetcher = fetch) {
  const token = secrets.TELEGRAM_BOT_TOKEN;
  const chatIds = Array.isArray(config.orderTelegramChatIds) ? config.orderTelegramChatIds : [];
  const enabled = Boolean(token && chatIds.length);
  return {
    enabled,
    async notifyOrder(order) {
      if (!enabled) return 0;
      const text = formatOrderMessage(config, order);
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
  };
}
