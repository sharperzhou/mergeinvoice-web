import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { loadInvoiceFile } from '../app/src/modules/invoices.js';
import { mergeInvoices, mergedFileName } from '../app/src/modules/merge.js';
import {
  A4_PORTRAIT,
  A5_LANDSCAPE,
  countMatches,
  makeInvoicePdf,
  readPageContent,
  readXObjectContents
} from './helpers.mjs';

async function loadRecord(specs) {
  const bytes = await makeInvoicePdf(specs);
  return loadInvoiceFile(new Blob([bytes]));
}

test('两张 A5 合并为一页 A4：两拼、第二张旋转 180°、有裁剪标记', async () => {
  const record = await loadRecord([
    { size: A5_LANDSCAPE, label: 'INV-A1', stamps: [{}] },
    { size: A5_LANDSCAPE, label: 'INV-A2' }
  ]);

  const { bytes, name, pageCount } = await mergeInvoices([record]);
  assert.equal(pageCount, 1);
  assert.match(name, /^合并发票\d{14}\.pdf$/);

  const out = await PDFDocument.load(bytes);
  const page = out.getPage(0);
  const media = page.getMediaBox();
  assert.ok(Math.abs(media.width - 595.28) < 0.01);
  assert.ok(Math.abs(media.height - 841.89) < 0.01);

  const content = readPageContent(page);
  assert.equal(countMatches(content, /\bDo\b/g), 2, '应绘制两个 XObject');

  // pdf-lib drawPage 的页面级变换为嵌套 cm：外层平移 +（必要时）旋转层。
  // 第一张：[1,0,0,1, 0, 422.36]；第二张：平移 [1,0,0,1, 595.28, 419.53] 叠加 180° 旋转 [-1,0,0,-1, 0, 0]
  const matrices = [...content.matchAll(/([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) cm/g)].map(
    (match) => match.slice(1, 7).map(Number)
  );
  assert.ok(
    matrices.some(([a, b, c, d]) => Math.abs(a + 1) < 1e-9 && Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9 && Math.abs(d + 1) < 1e-9),
    '应存在 180° 旋转矩阵'
  );
  assert.ok(
    matrices.some(
      ([a, b, c, d, e, f]) =>
        Math.abs(a - 1) < 1e-9 &&
        Math.abs(b) < 1e-9 &&
        Math.abs(c) < 1e-9 &&
        Math.abs(d - 1) < 1e-9 &&
        Math.abs(e) < 1e-9 &&
        Math.abs(f - 422.36) < 0.01
    ),
    '第一张应平移到页面上半部分'
  );
  assert.ok(
    matrices.some(
      ([a, , , d, e, f]) =>
        Math.abs(a - 1) < 1e-9 &&
        Math.abs(d - 1) < 1e-9 &&
        Math.abs(e - 595.28) < 1e-6 &&
        Math.abs(f - 419.53) < 1e-6
    ),
    '第二张平移锚点应在页面右侧中线'
  );

  assert.ok(countMatches(content, /(^|\n)S(\n|$)/g) >= 2, '中线应有两条裁剪标记线');

  // 印章外观已先扁平化进源页内容，随 embedPage 复制进表单 XObject 一并保留
  const xobjectContents = readXObjectContents(page);
  assert.equal(xobjectContents.length, 2, '应嵌入两个页面 XObject');
  assert.ok(
    xobjectContents.some((text) => /\bSEAL\b/.test(text)),
    '印章外观应随合并保留'
  );
});

test('奇数张 A5：最后一张单独一页，仍带裁剪标记', async () => {
  const record = await loadRecord([{ size: A5_LANDSCAPE, label: 'ONLY' }]);
  const { pageCount, bytes } = await mergeInvoices([record]);
  assert.equal(pageCount, 1);

  const out = await PDFDocument.load(bytes);
  const content = readPageContent(out.getPage(0));
  assert.equal(countMatches(content, /\bDo\b/g), 1);
  assert.ok(countMatches(content, /(^|\n)S(\n|$)/g) >= 2, '单独一页仍保留裁剪标记');
});

test('A5 与 A4 混合：A5 页在前，A4 整页无裁剪标记，超宽页跳过', async () => {
  const recordA = await loadRecord([
    { size: A5_LANDSCAPE, label: 'A1' },
    { size: A5_LANDSCAPE, label: 'A2' }
  ]);
  const recordB = await loadRecord([{ size: A5_LANDSCAPE, label: 'B1' }]);
  const recordC = await loadRecord([
    { size: A4_PORTRAIT, label: 'FULL' },
    { size: [700, 400], label: 'WIDE' } // 超宽 → 跳过
  ]);

  // A5：A1+A2 一页 + B1 单页 → 2 页；A4：FULL 一页 → 第 3 页
  const { pageCount, bytes } = await mergeInvoices([recordA, recordB, recordC]);
  assert.equal(pageCount, 3, '两张 A5 拼一页 + 一张 A5 单页 + 一张 A4 整页');

  const out = await PDFDocument.load(bytes);
  const third = out.getPage(2);
  const content = readPageContent(third);
  assert.equal(countMatches(content, /\bDo\b/g), 1);
  // A4 整页高度不满足 h+50 < 841.89 → 不画裁剪线
  assert.equal(countMatches(content, /(^|\n)S(\n|$)/g), 0, 'A4 整页不应有裁剪标记');
});

test('合并文件名格式', () => {
  const name = mergedFileName(new Date(2026, 9, 23, 14, 5, 9));
  assert.equal(name, '合并发票20261023140509.pdf');
});

test('无可合并页面时抛出错误', async () => {
  const record = await loadRecord([{ size: [700, 400], label: 'WIDE' }]);
  await assert.rejects(() => mergeInvoices([record]), /没有可合并的发票页面/);
});
