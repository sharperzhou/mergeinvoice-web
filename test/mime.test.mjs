import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeMimeWords, extractAttachments, parseMessageHeaders } from '../app/src/modules/mime.js';

// RFC822/MIME 附件解析：multipart 递归、CTE 解码、RFC2047/RFC2231 文件名

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ninvoice content here\n');

/** base64 编码（Node Buffer 在测试环境可用）。 */
function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** 按 CRLF 折行（模拟真实邮件 76 列折行，验证 base64 跨行拼接）。 */
function fold(text, width = 60) {
  const lines = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join('\r\n');
}

test('multipart/mixed：提取 base64 PDF 附件（含折行）', () => {
  const raw = [
    'From: service@163.com',
    'Subject: 电子发票',
    'Content-Type: multipart/mixed; boundary="BOUND123"',
    '',
    '--BOUND123',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    '正文：请查收附件',
    '--BOUND123',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    fold(b64(PDF_BYTES)),
    '--BOUND123--',
    ''
  ].join('\r\n');

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'invoice.pdf');
  assert.deepEqual(files[0].bytes, PDF_BYTES);
});

test('嵌套 multipart：multipart/alternative 内嵌 mixed 仍能取到附件', () => {
  const raw = [
    'Subject: nested',
    'Content-Type: multipart/mixed; boundary="OUTER"',
    '',
    '--OUTER',
    'Content-Type: multipart/alternative; boundary="INNER"',
    '',
    '--INNER',
    'Content-Type: text/plain',
    '',
    'plain body',
    '--INNER',
    'Content-Type: text/html',
    '',
    '<p>html body</p>',
    '--INNER--',
    '--OUTER',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="nested.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES),
    '--OUTER--',
    ''
  ].join('\r\n');

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'nested.pdf');
  assert.deepEqual(files[0].bytes, PDF_BYTES);
});

test('quoted-printable 附件与裸 PDF 邮件（无 multipart、无文件名）', () => {
  // QP：=41 还原为 A，软换行去除
  const qpMail = [
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '%PDF-1.7 invo=69ce=0a'
  ].join('\r\n');
  const qpFiles = extractAttachments(qpMail);
  assert.equal(qpFiles.length, 1);
  assert.equal(new TextDecoder().decode(qpFiles[0].bytes), '%PDF-1.7 invoice\n');
  assert.equal(qpFiles[0].filename, '附件-1.pdf'); // 无文件名时自动编号

  // 裸附件：整个正文即 PDF 字节（8bit）
  const bare = [
    'Content-Type: application/pdf; name="bare.pdf"',
    'Content-Transfer-Encoding: 8bit',
    '',
    new TextDecoder().decode(PDF_BYTES)
  ].join('\r\n');
  const bareFiles = extractAttachments(bare);
  assert.equal(bareFiles[0].filename, 'bare.pdf');
  assert.deepEqual(bareFiles[0].bytes, PDF_BYTES);
});

test('ZIP 附件按扩展名收录、非目标类型与正文不收录', () => {
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const raw = [
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    '正文不收录',
    '--B',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: attachment; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(new Uint8Array([1, 2, 3])),
    '--B',
    'Content-Type: application/zip',
    'Content-Disposition: attachment; filename="12306.zip"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(zipBytes),
    '--B--',
    ''
  ].join('\r\n');

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, '12306.zip');
  assert.deepEqual(files[0].bytes, zipBytes);
});

test('RFC2047 编码文件名与相邻编码词空白忽略', () => {
  // 「电子发票.pdf」的 UTF-8 base64 编码词
  const encoded = `=?UTF-8?B?${b64(new TextEncoder().encode('电子发票.pdf'))}?=`;
  const raw = [
    'Content-Type: application/pdf',
    `Content-Disposition: attachment; filename="${encoded}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES)
  ].join('\r\n');
  const files = extractAttachments(raw);
  assert.equal(files[0].filename, '电子发票.pdf');

  // 相邻编码词间的折行空白被忽略：「联合声明.pdf」
  const part1 = `=?UTF-8?B?${b64(new TextEncoder().encode('联合'))}?=`;
  const part2 = `=?UTF-8?B?${b64(new TextEncoder().encode('声明'))}?=`;
  assert.equal(decodeMimeWords(`${part1}\r\n  ${part2}.pdf`), '联合声明.pdf');
});

test('RFC2231 filename*：charset 百分号编码', () => {
  const utf8Name = encodeURIComponent('华住会发票.pdf');
  const raw = [
    'Content-Type: application/pdf',
    `Content-Disposition: attachment; filename*=UTF-8''${utf8Name}`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES)
  ].join('\r\n');
  const files = extractAttachments(raw);
  assert.equal(files[0].filename, '华住会发票.pdf');
});

test('无附件邮件返回空数组（multipart 只有正文）', () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    '本期账单明细……',
    '--B--',
    ''
  ].join('\r\n');
  assert.deepEqual(extractAttachments(raw), []);
});

test('parseMessageHeaders：主题/发件人/日期取原始值（未解码）', () => {
  const didiWord = `=?UTF-8?B?${b64(new TextEncoder().encode('滴滴出行'))}?=`;
  const raw = [
    `From: ${didiWord}<noreply@didi.com>`,
    'Subject: [滴滴出行] 行程单与电子发票',
    'Date: Fri, 30 Oct 2026 08:30:00 +0800',
    'Content-Type: text/plain',
    '',
    'body'
  ].join('\r\n');
  const headers = parseMessageHeaders(raw);
  assert.equal(headers.date, 'Fri, 30 Oct 2026 08:30:00 +0800');
  assert.equal(headers.from, `${didiWord}<noreply@didi.com>`);
  assert.equal(headers.subject, '[滴滴出行] 行程单与电子发票');
  assert.equal(decodeMimeWords(`${didiWord} <noreply@didi.com>`), '滴滴出行 <noreply@didi.com>');
});

test('损坏的 base64 附件被跳过，其余附件正常提取', () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="broken.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    '!!!not-base64!!!',
    '--B',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="good.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES),
    '--B--',
    ''
  ].join('\r\n');
  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'good.pdf');
});
