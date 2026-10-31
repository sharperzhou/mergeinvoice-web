import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  PROVIDERS,
  ValidationError,
  parseDate,
  parseLimit,
  parseUid,
  requireString,
  resolveDateRange,
  resolveProvider
} from '../worker/src/validate.js';

// Worker API 入参校验：服务商白名单、日期区间（90 天上限、BEFORE +1 天换算）、uid/limit

test('resolveProvider：白名单映射与拒绝', () => {
  assert.equal(resolveProvider('163'), 'imap.163.com');
  assert.equal(resolveProvider('126'), 'imap.126.com');
  assert.equal(resolveProvider('yeah'), 'imap.yeah.net');
  assert.equal(resolveProvider('qq'), 'imap.qq.com');
  assert.equal(Object.keys(PROVIDERS).length, 4);
  assert.throws(() => resolveProvider('evil.example.com'), ValidationError);
  assert.throws(() => resolveProvider('imap.163.com.evil.com'), ValidationError);
  assert.throws(() => resolveProvider(undefined), ValidationError);
  assert.throws(() => resolveProvider(123), ValidationError);
});

test('requireString：空值/非字符串拒绝，去除首尾空白', () => {
  assert.equal(requireString('  a@163.com  ', '邮箱账号'), 'a@163.com');
  assert.throws(() => requireString('', '授权码'), /授权码不能为空/);
  assert.throws(() => requireString('   ', '授权码'), ValidationError);
  assert.throws(() => requireString(null, '授权码'), ValidationError);
  assert.throws(() => requireString(42, '授权码'), ValidationError);
});

test('parseDate：格式与真实日期严格校验', () => {
  assert.equal(parseDate('2026-10-01', '开始日期').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseDate('2026/10/01', '开始日期'), /YYYY-MM-DD/);
  assert.throws(() => parseDate('2026-02-30', '开始日期'), /不是有效日期/);
  assert.throws(() => parseDate('2026-13-01', '开始日期'), /不是有效日期/);
  assert.throws(() => parseDate('26-10-01', '开始日期'), ValidationError);
  assert.throws(() => parseDate(undefined, '开始日期'), ValidationError);
});

test('resolveDateRange：正常区间、before 为结束日次日（含当日语义）', () => {
  const { since, before } = resolveDateRange('2026-10-01', '2026-10-31');
  assert.equal(since.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(before.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('resolveDateRange：倒置与超 90 天拒绝，边界 90 天放行', () => {
  assert.throws(() => resolveDateRange('2026-10-31', '2026-10-01'), /不能早于/);
  // 恰好 90 天：起止日相差 90 天 → 放行
  const ok = resolveDateRange('2026-08-01', '2026-10-30');
  assert.ok((ok.before - ok.since) / 86400000 === MAX_RANGE_DAYS + 1);
  // 91 天 → 拒绝
  assert.throws(() => resolveDateRange('2026-08-01', '2026-10-31'), /90 天/);
});

test('parseUid：正整数校验', () => {
  assert.equal(parseUid(1), 1);
  assert.equal(parseUid(12345), 12345);
  assert.throws(() => parseUid(0), ValidationError);
  assert.throws(() => parseUid(-1), ValidationError);
  assert.throws(() => parseUid(1.5), ValidationError);
  assert.throws(() => parseUid('12'), ValidationError);
  assert.throws(() => parseUid(undefined), ValidationError);
});

test('parseLimit：缺省默认值、范围内接受、越界拒绝', () => {
  assert.equal(parseLimit(undefined), DEFAULT_LIMIT);
  assert.equal(parseLimit(null), DEFAULT_LIMIT);
  assert.equal(parseLimit(50), 50);
  assert.equal(parseLimit(MAX_LIMIT), MAX_LIMIT);
  assert.throws(() => parseLimit(0), ValidationError);
  assert.throws(() => parseLimit(MAX_LIMIT + 1), ValidationError);
  assert.throws(() => parseLimit(1.5), ValidationError);
  assert.throws(() => parseLimit('50'), ValidationError);
});
