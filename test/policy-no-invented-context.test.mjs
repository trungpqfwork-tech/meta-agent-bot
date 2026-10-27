// Chủ Page báo 28/10/2026: khách hỏi "có ốc nhồi ống tre không", bot tự thêm
// "bữa liên hoan" dù khách chưa nói dịp gì. Nguyên nhân: "liên hoan" nằm trong
// policy làm VÍ DỤ, model dùng ví dụ như dữ kiện hội thoại. Test này giữ quy tắc
// cấm tự gán ngữ cảnh khách chưa nói.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPolicy } from '../src/knowledge.mjs';

test('policy CSKH: không tự gán ngữ cảnh khách chưa nói (dịp dùng, số người, mục đích)', () => {
  assert.match(agentPolicy, /Dữ kiện của hội thoại CHỈ gồm điều khách đã nói trong phiên này và nội dung trong documents/);
  assert.match(agentPolicy, /chỉ để minh hoạ cách hiểu, KHÔNG phải thông tin của khách/);
  assert.match(agentPolicy, /không tự gán dịp dùng \(liên hoan, sinh nhật, giỗ, tiệc cưới\)/);
  assert.match(agentPolicy, /Thiếu ngữ cảnh thì hỏi lại đúng 1 câu, không tự điền/);
});

test('policy CSKH: quy tắc chống gán ngữ cảnh đứng trước phần giá (không làm loãng luật giá)', () => {
  const iRule = agentPolicy.indexOf('Dữ kiện của hội thoại CHỈ gồm');
  const iPrice = agentPolicy.indexOf('Về giá: giá đã bao gồm VAT');
  assert.ok(iRule > 0 && iPrice > 0 && iRule < iPrice, 'quy tắc phải nằm trước phần giá');
});
