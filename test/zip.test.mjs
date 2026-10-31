import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { extractPdfEntries, isZipFile, MAX_ZIP_ENTRIES } from '../app/src/modules/zip.js';

// ZIP 解压：PDF 提取、GBK 文件名修复、目录/非 PDF 过滤、安全限额

const PDF_MAGIC = new TextEncoder().encode('%PDF-1.7\nfake invoice body\n');

/** 构造最小 stored（不压缩）ZIP：完全控制标志位与文件名字节，用于 GBK/限额场景。 */
function makeStoredZip(items) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const item of items) {
    const { nameBytes, data, claimSize } = item;
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    lv.setUint16(4, 20, true); // 需要的解压版本
    lv.setUint16(6, 0, true); // 标志位：不置 UTF-8 位（模拟国产压缩包）
    lv.setUint16(8, 0, true); // 压缩方法：stored
    lv.setUint16(10, 0, true); // 时间
    lv.setUint16(12, 0x21, true); // 日期（1980-01-01）
    lv.setUint32(14, 0, true); // crc32（本实现不校验）
    lv.setUint32(18, data.length, true); // 压缩后大小
    lv.setUint32(22, data.length, true); // 未压缩大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra 长度
    locals.push(local, nameBytes, data);

    const central = new Uint8Array(46);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录签名
    cv.setUint16(4, 20, true); // 制作者版本
    cv.setUint16(6, 20, true); // 需要的解压版本
    cv.setUint16(8, 0, true); // 标志位
    cv.setUint16(10, 0, true); // stored
    cv.setUint16(12, 0, true); // 时间
    cv.setUint16(14, 0x21, true); // 日期
    cv.setUint32(16, 0, true); // crc32
    cv.setUint32(20, data.length, true); // 压缩后大小
    // 未压缩大小：可声明为更大值（用于触发总大小限额）
    cv.setUint32(24, typeof claimSize === 'number' ? claimSize : data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra 长度
    cv.setUint16(32, 0, true); // 注释长度
    cv.setUint16(34, 0, true); // 起始磁盘
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true); // 本地头偏移
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD 签名
  ev.setUint16(8, items.length, true); // 本磁盘条目数
  ev.setUint16(10, items.length, true); // 总条目数
  ev.setUint32(12, centralBytes.length, true); // 中央目录大小
  ev.setUint32(16, offset, true); // 中央目录偏移
  return concat([...locals, centralBytes, eocd]);
}

/** 拼接字节数组列表。 */
function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

test('fflate 压缩包：提取 PDF 并跳过非 PDF 与目录', () => {
  const zip = zipSync({
    '发票-001.pdf': PDF_MAGIC,
    'readme.txt': new TextEncoder().encode('not a pdf'),
    'nested/发票-002.pdf': PDF_MAGIC,
    'nested/': new Uint8Array(0) // 目录条目
  });
  const entries = extractPdfEntries(zip);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['发票-001.pdf', 'nested/发票-002.pdf']
  );
  assert.deepEqual(entries[0].bytes, PDF_MAGIC);
});

test('GBK 文件名（不置 UTF-8 标志位）按 GBK 解码还原', () => {
  // 「中国.pdf」的 GBK 字节：中=D6D0、国=B9FA、.pdf=2E706466
  const nameBytes = new Uint8Array([0xd6, 0xd0, 0xb9, 0xfa, 0x2e, 0x70, 0x64, 0x66]);
  const zip = makeStoredZip([{ nameBytes, data: PDF_MAGIC }]);
  const entries = extractPdfEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '中国.pdf');
  assert.deepEqual(entries[0].bytes, PDF_MAGIC);
});

test('UTF-8 文件名（置标志位）正常解码', () => {
  const zip = zipSync({ '火车票电子发票.pdf': PDF_MAGIC });
  const entries = extractPdfEntries(zip);
  assert.equal(entries[0].name, '火车票电子发票.pdf');
});

test('压缩包内无 PDF 时返回空数组', () => {
  const zip = zipSync({ 'a.txt': new TextEncoder().encode('x') });
  assert.deepEqual(extractPdfEntries(zip), []);
});

test('非 ZIP 字节抛出「已损坏」错误', () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.throws(() => extractPdfEntries(junk), /已损坏或格式不支持/);
});

test(`条目数超过 ${MAX_ZIP_ENTRIES} 时拒绝（zip 炸弹防护）`, () => {
  const files = {};
  for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i++) {
    files[`f${i}.pdf`] = PDF_MAGIC;
  }
  assert.throws(() => extractPdfEntries(zipSync(files)), /文件过多/);
});

test('解压后总大小超限时在解压前拒绝（zip 炸弹防护）', () => {
  // 中央目录声明未压缩大小为 201MB（实际数据很小），总大小限额应先行拦截
  const zip = makeStoredZip([
    { nameBytes: new TextEncoder().encode('big.pdf'), data: PDF_MAGIC, claimSize: 201 * 1024 * 1024 }
  ]);
  assert.throws(() => extractPdfEntries(zip), /超过上限/);
});

test('isZipFile：按 MIME 或扩展名判断', () => {
  assert.equal(isZipFile({ name: 'a.zip', type: '' }), true);
  assert.equal(isZipFile({ name: 'a.ZIP', type: 'application/x-zip-compressed' }), true);
  assert.equal(isZipFile({ name: 'a.pdf', type: 'application/pdf' }), false);
});
