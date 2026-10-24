import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDict } from 'pdf-lib';
import {
  exceedsPageLimit,
  loadInvoiceFile,
  MAX_IMPORT_PAGES,
  probePageCount,
  sha256Hex
} from '../src/modules/invoices.js';
import { A4_PORTRAIT, A5_LANDSCAPE, makeInvoicePdf, resourceKeys } from './helpers.mjs';

// 页面分类规则：
// 宽 > 615pt → skip；高 < 420.9445pt → A5；否则 → A4

test('A5 横向页分类为 A5', async () => {
  const bytes = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'INV-A5' }]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.equal(record.error, null);
  assert.deepEqual(
    record.pages.map((page) => page.kind),
    ['A5']
  );
  // 有效盒尺寸应与页面尺寸一致
  assert.ok(Math.abs(record.pages[0].w - A5_LANDSCAPE[0]) < 0.01);
  assert.ok(Math.abs(record.pages[0].h - A5_LANDSCAPE[1]) < 0.01);
});

test('A4 竖向整页分类为 A4', async () => {
  const bytes = await makeInvoicePdf([{ size: A4_PORTRAIT, label: 'INV-A4' }]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.deepEqual(
    record.pages.map((page) => page.kind),
    ['A4']
  );
});

test('超出 A4 宽度的页面跳过', async () => {
  const bytes = await makeInvoicePdf([{ size: [700, 400], label: 'WIDE' }]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.deepEqual(
    record.pages.map((page) => page.kind),
    ['skip']
  );
  assert.equal(record.pages[0].reason, '超出 A4 宽度');
});

test('MediaBox 与 CropBox 取交集后分类', async () => {
  // MediaBox 为 A4 整页，CropBox 裁掉上半部分 → 有效高度 ≈ 419.89 < 420.9445 → A5
  const bytes = await makeInvoicePdf([
    { size: A4_PORTRAIT, crop: [0, 422, 595.28, 841.89], label: 'CROPPED' }
  ]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.deepEqual(
    record.pages.map((page) => page.kind),
    ['A5']
  );
  assert.ok(Math.abs(record.pages[0].h - 419.89) < 0.01);
});

test('混合文档多页分类', async () => {
  const bytes = await makeInvoicePdf([
    { size: A5_LANDSCAPE, label: 'P1' },
    { size: A4_PORTRAIT, label: 'P2' },
    { size: [800, 300], label: 'P3' } // 超宽 → skip
  ]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.deepEqual(
    record.pages.map((page) => page.kind),
    ['A5', 'A4', 'skip']
  );
});

test('pdf-lib 文档加载成功且页面字体资源可读', async () => {
  const mergeableBytes = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'A' }]);
  const mergeable = await loadInvoiceFile(new Blob([mergeableBytes]));
  assert.equal(typeof mergeable.doc, 'object');
  // normalizedEntries 会补全 Resources/Font 等结构，断言字体键可枚举
  assert.ok(resourceKeys(mergeable.doc.getPage(0), 'Font').length > 0);
  assert.ok(mergeable.doc.getPage(0).node.normalizedEntries().Resources instanceof PDFDict);
});

test('内容哈希：相同字节一致、不同内容不同、记录携带哈希', async () => {
  const bytesA = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'HASH-A' }]);
  const bytesB = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'HASH-B' }]);

  const h1 = await sha256Hex(bytesA);
  const h2 = await sha256Hex(bytesA);
  assert.equal(h1, h2, '相同字节应得到相同哈希');

  const h3 = await sha256Hex(bytesB);
  assert.notEqual(h1, h3, '不同内容应得到不同哈希');

  const record = await loadInvoiceFile(new Blob([bytesA]));
  assert.equal(record.hash, h1, '导入记录应携带内容哈希');
});

test('页数探测与导入上限：10 页放行、11 页拒绝、损坏文件返回 null', async () => {
  const atLimit = await makeInvoicePdf(
    Array.from({ length: MAX_IMPORT_PAGES }, (_, i) => ({ label: `P${i + 1}` }))
  );
  const overLimit = await makeInvoicePdf(
    Array.from({ length: MAX_IMPORT_PAGES + 1 }, (_, i) => ({ label: `P${i + 1}` }))
  );

  assert.equal(await probePageCount(atLimit), MAX_IMPORT_PAGES, '应探测出准确页数');
  assert.equal(exceedsPageLimit(MAX_IMPORT_PAGES), false, '恰好等于上限应允许导入');
  assert.equal(exceedsPageLimit(MAX_IMPORT_PAGES + 1), true, '超出上限一页应拒绝');
  assert.equal(exceedsPageLimit(null), false, '探测失败不按超限处理（交由错误展示流程）');
  assert.equal(await probePageCount(new Uint8Array([1, 2, 3])), null, '损坏文件探测应返回 null');
});
