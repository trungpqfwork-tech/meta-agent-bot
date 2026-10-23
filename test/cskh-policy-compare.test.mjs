// Chủ Page chốt 19/10/2026: chỉ so sánh thương hiệu/đặc tính khi khách hỏi trực tiếp,
// không tự tư vấn cảm tính kiểu "nhiều mỡ" (ba chỉ bò Excel là vân mỡ đan xen đồng đều).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPolicy } from '../src/knowledge.mjs';

test('policy CSKH: không tự nêu so sánh/nhận xét cảm tính khi khách chưa hỏi',()=>{
  assert.match(agentPolicy,/Chỉ so sánh giữa các thương hiệu\/mặt hàng khi khách hỏi trực tiếp/);
  assert.match(agentPolicy,/không tự nêu nhận xét cảm tính/);
});
