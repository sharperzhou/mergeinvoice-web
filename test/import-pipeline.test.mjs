import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importEntries } from '../app/src/modules/import-pipeline.js';
import { MAX_IMPORT_PAGES } from '../app/src/modules/invoices.js';
import { A5_LANDSCAPE, makeInvoicePdf } from './helpers.mjs';

// 通用导入管道：去重 → 页数上限 → 创建记录（文件/ZIP/邮件附件三路来源共用）

/** 造一个条目：{ name, bytes }，size 缺省走 bytes.byteLength。 */
async function entry(name, pageSpecs) {
  return { name, bytes: await makeInvoicePdf(pageSpecs) };
}

test('正常导入：按顺序创建记录并回调 onRecord', async () => {
  const a = await entry('a.pdf', [{ size: A5_LANDSCAPE, label: 'A' }]);
  const b = await entry('b.pdf', [{ size: A5_LANDSCAPE, label: 'B' }]);
  const seen = [];
  const result = await importEntries([a, b], {
    onRecord: (record) => {
      seen.push(record.name);
    }
  });
  assert.deepEqual(seen, ['a.pdf', 'b.pdf']);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].error, null);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.notes, '');
});

test('内容重复：跳过第二份且不重复建记录', async () => {
  const a1 = await entry('dup-1.pdf', [{ size: A5_LANDSCAPE, label: 'DUP' }]);
  const a2 = { name: 'dup-2.pdf', bytes: a1.bytes }; // 同字节不同文件名
  const result = await importEntries([a1, a2]);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.skipped, ['dup-2.pdf']);
  assert.match(result.notes, /已跳过 1 个重复文件：dup-2\.pdf/);
});

test('与已有记录重复：existingHashes 命中即跳过', async () => {
  const a = await entry('again.pdf', [{ size: A5_LANDSCAPE, label: 'AGAIN' }]);
  const first = await importEntries([a]);
  const hash = first.records[0].hash;
  const second = await importEntries([a], { existingHashes: [hash] });
  assert.equal(second.records.length, 0);
  assert.deepEqual(second.skipped, ['again.pdf']);
});

test(`超过 ${MAX_IMPORT_PAGES} 页：拒绝且不记入去重集合，重试仍拒绝`, async () => {
  const specs = [];
  for (let i = 0; i < MAX_IMPORT_PAGES + 1; i++) {
    specs.push({ size: A5_LANDSCAPE, label: `P${i}` });
  }
  const big = { name: 'big.pdf', bytes: await makeInvoicePdf(specs) };
  const first = await importEntries([big]);
  assert.equal(first.records.length, 0);
  assert.deepEqual(first.rejected, [`big.pdf（${MAX_IMPORT_PAGES + 1} 页）`]);
  assert.match(first.notes, /已拒绝 1 个超限文件/);

  // 被拒文件不记入 seen：再次导入仍按超限原因拒绝（而非误报“重复”）
  const second = await importEntries([big]);
  assert.deepEqual(second.rejected, [`big.pdf（${MAX_IMPORT_PAGES + 1} 页）`]);
  assert.deepEqual(second.skipped, []);
});

test('onStatus 按检查页数、导入两个阶段推送进度', async () => {
  const a = await entry('status.pdf', [{ size: A5_LANDSCAPE, label: 'S' }]);
  const messages = [];
  await importEntries([a], { onStatus: (text) => messages.push(text) });
  assert.deepEqual(messages, ['正在检查页数：status.pdf …', '正在导入：status.pdf …']);
});

test('缺省 name 使用「未命名.pdf」', async () => {
  const bytes = await makeInvoicePdf([{ size: A5_LANDSCAPE, label: 'NONAME' }]);
  const result = await importEntries([{ bytes }]);
  assert.equal(result.records[0].name, '未命名.pdf');
});
