import { inflateSync } from 'fflate';

// ZIP 解析与解压（本地文件导入 / 邮件附件两路共用）：
// 不直接用 fflate 的 unzipSync 文件名解码——12306 等国产压缩包文件名常为 GBK
// 且不置 UTF-8 标志位，此处手动解析中央目录拿到原始名字节自行解码，
// 同时可在解压前读取未压缩大小做 zip 炸弹防护。

/** ZIP 条目数上限（防 zip 炸弹）。 */
export const MAX_ZIP_ENTRIES = 500;
/** ZIP 解压后总字节上限 200MB（防 zip 炸弹）。 */
export const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDIR_SIG = 0x02014b50; // 中央目录条目
const LOCAL_SIG = 0x04034b50; // 本地文件头
const FLAG_UTF8 = 0x800; // 通用标志位 bit11：文件名按 UTF-8 编码

/** 是否为可导入的 ZIP 文件（MIME 或扩展名判断，兼容 Windows 拖拽的 x-zip-compressed）。 */
export function isZipFile(file) {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    /\.zip$/i.test(file.name || '')
  );
}

/**
 * 从 ZIP 字节中提取全部 PDF 条目 → [{ name, bytes }]。
 * - 非 PDF 条目与目录静默跳过；无 PDF 时返回空数组；
 * - 条目数 / 解压总大小超限直接抛错（中文提示）；
 * - 损坏、ZIP64、不支持的压缩方法均抛错，由调用方逐文件捕获展示。
 */
export function extractPdfEntries(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = readCentralEntries(zipBytes, view);

  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP 内文件过多（${entries.length} 个，上限 ${MAX_ZIP_ENTRIES} 个）`);
  }
  let total = 0;
  for (const entry of entries) total += entry.uncompSize;
  if (total > MAX_ZIP_TOTAL_BYTES) {
    throw new Error(
      `ZIP 解压后总大小超过上限（${(total / 1024 / 1024).toFixed(1)} MB，上限 ${MAX_ZIP_TOTAL_BYTES / 1024 / 1024} MB）`
    );
  }

  const result = [];
  for (const entry of entries) {
    if (entry.isDir || !/\.pdf$/i.test(entry.name)) continue;
    result.push({ name: entry.name, bytes: readEntryData(zipBytes, view, entry) });
  }
  return result;
}

/** 解析 End Of Central Directory 与中央目录，返回条目描述数组。 */
function readCentralEntries(bytes, view) {
  // EOCD 固定 22 字节 + 最长 65535 字节注释，从尾部向前扫描签名
  const eocd = findEocd(view, bytes.length);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdirSize = view.getUint32(eocd + 12, true);
  const cdirOff = view.getUint32(eocd + 16, true);
  if (cdirOff + cdirSize > bytes.length || cdirOff + cdirSize < cdirOff) {
    throw new Error('ZIP 文件已损坏或格式不支持');
  }

  const entries = [];
  let pos = cdirOff;
  const end = cdirOff + cdirSize;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== CDIR_SIG) {
      throw new Error('ZIP 文件已损坏或格式不支持');
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff = view.getUint32(pos + 42, true);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 压缩包');
    }
    const rawName = bytes.subarray(pos + 46, pos + 46 + nameLen);
    const name = decodeZipName(rawName, (flags & FLAG_UTF8) !== 0);
    entries.push({ name, isDir: name.endsWith('/'), method, compSize, uncompSize, localOff });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 从文件尾部向前查找 EOCD 签名（返回其起始偏移）。 */
function findEocd(view, length) {
  const min = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('ZIP 文件已损坏或格式不支持');
}

/**
 * 解码 ZIP 条目文件名：
 * 先按严格 UTF-8 解码（错误即抛）成功则用之；失败回退 GBK（国产压缩包主流编码，
 * 12306 发票包文件名即此情形）；两者都失败按宽松 UTF-8 保留可读残片。
 * 与标志位是否置 UTF-8 位无关——部分工具置位但名字仍是 GBK，以字节本身为准。
 */
function decodeZipName(rawName, isUtf8Flag) {
  const strict = (label) => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(rawName);
    } catch {
      return null;
    }
  };
  const utf8 = strict('utf-8');
  if (utf8 !== null) return utf8;
  const gbk = strict('gbk');
  if (gbk !== null) return gbk;
  void isUtf8Flag; // 仅作可读性保留：两法皆败时宽松解码，不因标志位误判而抛错
  return new TextDecoder('utf-8').decode(rawName);
}

/** 按本地文件头定位压缩数据切片并解压（stored 直接切片，deflate 走 fflate）。 */
function readEntryData(bytes, view, entry) {
  const off = entry.localOff;
  if (off + 30 > bytes.length || view.getUint32(off, true) !== LOCAL_SIG) {
    throw new Error('ZIP 文件已损坏或格式不支持');
  }
  // 本地头的 name/extra 长度可能与中央目录不同，必须以本地头为准计算数据起点
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  if (start + entry.compSize > bytes.length) {
    throw new Error('ZIP 文件已损坏或格式不支持');
  }
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data; // stored：压缩数据即原文
  if (entry.method === 8) return inflateSync(data); // deflate
  throw new Error(`ZIP 内「${entry.name}」使用了不支持的压缩方法（${entry.method}）`);
}
