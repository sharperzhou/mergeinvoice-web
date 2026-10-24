import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadInvoiceFile } from '../src/modules/invoices.js';
import {
  A5_LANDSCAPE,
  makeInvoicePdf,
  readPageContent,
  resourceKeys
} from './helpers.mjs';

// 验证 flattenDocument：
// 有外观注解 → 烘焙进内容流并从 /Annots 移除；无外观注解 → 原样保留。

test('带外观的印章注解被烘焙进页面内容（flate）', async () => {
  const bytes = await makeInvoicePdf([
    { size: A5_LANDSCAPE, label: 'INV-1', stamps: [{}], link: true }
  ]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.equal(record.error, null);
  assert.equal(record.flattened, 1, '应烘焙 1 个印章外观');

  const page = record.doc.getPage(0);
  const annots = page.node.Annots();
  assert.equal(annots.size(), 1, '无外观的 Link 注解应保留');

  const content = readPageContent(page);
  // 烘焙内容包含 q/cm/Q 包装、外观操作符、改名后的字体引用
  assert.match(content, /\/Sig\d+_F1/);
  assert.match(content, /\bSEAL\b/);
  assert.match(content, / cm\n/);
  // 烘焙后的外观内容中旧字体引用应全部替换为 /SigN_F1（不再出现裸 /F1）
  assert.doesNotMatch(content, /\/F1 /m);

  // 页面原有字体键保留（pdf-lib 为标准字体可能生成多个 Helvetica-* 键），
  // 烘焙仅新增一个带 Sig 前缀的键
  const fontKeys = resourceKeys(page, 'Font');
  const sigKeys = fontKeys.filter((key) => /^\/Sig\d+_F1$/.test(key));
  assert.equal(sigKeys.length, 1, '烘焙字体应带 Sig 前缀且只新增一个');
  assert.ok(fontKeys.length >= 2, '页面原有字体键应保留');
});

test('非 Flate 外观同样被烘焙，多个注解全部处理', async () => {
  const bytes = await makeInvoicePdf([
    {
      size: A5_LANDSCAPE,
      label: 'INV-2',
      stamps: [
        { flate: false, rect: [60, 60, 220, 140], label: 'PLAIN' },
        { flate: true, rect: [240, 60, 400, 140], label: 'SEAL' }
      ]
    }
  ]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.equal(record.flattened, 2);

  const page = record.doc.getPage(0);
  const annots = page.node.Annots();
  assert.equal(annots.size(), 0, '两个有外观的注解都应被移除');

  const content = readPageContent(page);
  assert.match(content, /\bPLAIN\b/);
  assert.match(content, /\bSEAL\b/);
  // 两个外观各自的字体应改名并入页面资源（对象号不同 → 键不同）
  const sigKeys = resourceKeys(page, 'Font').filter((key) => /^\/Sig\d+_F1$/.test(key));
  assert.equal(sigKeys.length, 2, '两个外观的字体应分别烘焙为不同键');
});

test('无注解文档：flattened 为 0，内容不变', async () => {
  const bytes = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'BARE' }]);
  const record = await loadInvoiceFile(new Blob([bytes]));
  assert.equal(record.flattened, 0);
  const content = readPageContent(record.doc.getPage(0));
  assert.doesNotMatch(content, /Sig\d+_F1/);
});

test('缺少 BBox 的外观注解保留不烘焙', async () => {
  // 制造一个 BBox 缺失的外观流：烘焙应放弃（返回 null），注解保留在 /Annots
  const bytes = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'NOBBOX', stamps: [{}] }]);
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const annots = page.node.Annots();
  const annot = doc.context.lookup(annots.get(0));
  const ap = doc.context.lookup(annot.get(PDFName.of('AP')));
  const n = doc.context.lookup(ap.get(PDFName.of('N')));
  n.dict.delete(PDFName.of('BBox'));
  const modified = await doc.save({ useObjectStreams: false });

  const record = await loadInvoiceFile(new Blob([modified]));
  assert.equal(record.flattened, 0);
  assert.equal(record.doc.getPage(0).node.Annots().size(), 1);
});
