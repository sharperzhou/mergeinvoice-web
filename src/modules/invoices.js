import { PDFArray, PDFDocument, PDFNumber } from 'pdf-lib';
import { flattenDocument } from './flatten.js';

// 分类阈值：
// 有效宽度 > 615pt 视为不可放入 A4 而跳过；
// 有效高度 < 841.889/2（≈420.9445pt）判为 A5，否则判为 A4 整页。
const WIDTH_LIMIT = 615;
const HALF_HEIGHT_LIMIT = 841.889 / 2;

// 单个 PDF 的导入页数上限：超限直接拒绝导入并提示，
// 防止 1000+ 页大文档在「页」管理预览时被逐页渲染拖垮浏览器
export const MAX_IMPORT_PAGES = 10;

let nextId = 1;

/**
 * 快速探测 PDF 页数：只解析文档结构（不做扁平化/分类等重活），
 * 用于导入前的页数上限检查。解析失败返回 null，交由 createInvoiceRecord 走错误展示流程。
 */
export async function probePageCount(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

/** 页数是否超出导入上限（探测失败返回 null 时不按超限处理）。 */
export function exceedsPageLimit(pageCount) {
  return typeof pageCount === 'number' && pageCount > MAX_IMPORT_PAGES;
}

/**
 * 计算文件内容哈希（用于重复导入检测）。
 * 安全上下文（https / localhost）使用 crypto.subtle 的 SHA-256；
 * 非安全上下文（如局域网 http，subtle 不可用）退化为 FNV-1a，
 * 仅用于去重提示，前缀区分算法。
 */
export async function sha256Hex(bytes) {
  if (globalThis.crypto && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      /* 退化到 FNV-1a */
    }
  }
  return `fnv:${bytes.length.toString(16)}-${fnv1a32(bytes)}`;
}

/** 32 位 FNV-1a（非安全上下文下的去重兜底哈希）。 */
function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 从 File/Blob 读取字节后创建发票记录。 */
export async function loadInvoiceFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return createInvoiceRecord({
    name: file.name || '未命名.pdf',
    size: file.size ?? bytes.byteLength,
    bytes
  });
}

/**
 * 由已读取的字节创建导入记录：
 * - hash 为内容哈希（去重依据）；
 * - doc 为 pdf-lib 文档（已执行注解外观扁平化，供 embedPage 合并用）；
 * - pages 逐页分类结果（A5 / A4 / skip 及有效盒 Box）；
 * - previewPage 为列表预览的当前页码（1 起）。
 * 任何加载/解析失败都写入 record.error，不抛出，便于 UI 逐文件展示。
 */
export async function createInvoiceRecord({ name, size, bytes }) {
  const record = {
    id: `inv-${nextId++}`,
    name,
    size: size ?? bytes.byteLength,
    bytes,
    hash: await sha256Hex(bytes),
    doc: null,
    pdfDoc: null, // pdf.js 文档句柄（懒加载，预览时创建）
    previewBytes: null, // flatten 后的字节（有烘焙时生成），预览与合并看到同一内容
    pages: [],
    excluded: new Set(), // 用户删除的页码集合（1 起），合并/统计时跳过，可恢复
    flattened: 0, // 烘焙的印章/签名外观数量
    error: null,
    card: null, // UI 卡片元素引用（main.js 填充）
    previewPage: 1,
    preview: null // 预览区 DOM 引用（main.js 填充）
  };

  try {
    record.doc = await PDFDocument.load(bytes, {
      // 加密文件仍尝试读取结构；真实解密不支持，内容渲染可能失败但不阻塞导入
      ignoreEncryption: true,
      updateMetadata: false, // 不改写 Producer/ModDate，尽量保持原文件元数据
      throwOnInvalidObject: false
    });
    record.flattened = await flattenDocument(record.doc);
    // 有烘焙时另存一份字节供 pdf.js 预览：注解外观已并入内容流，
    // 避免 pdf.js 对个别注解类型渲染不全导致「预览丢内容、合并却正常」
    if (record.flattened > 0) {
      try {
        record.previewBytes = await record.doc.save({ useObjectStreams: false });
      } catch {
        record.previewBytes = null; // 保存失败退回原始字节预览
      }
    }
    record.doc.getPages().forEach((page, index) => {
      record.pages.push(classifyPage(page, index));
    });
  } catch (error) {
    record.error = error && error.message ? error.message : String(error);
  }

  return record;
}

/** 页面是否未被用户删除（记录无 excluded 集时视为全部保留，兼容旧结构/测试夹具）。 */
export function isPageIncluded(record, page) {
  return !(record.excluded && record.excluded.has(page.index + 1));
}

/** 记录中是否至少有一张未删除的 A5 / A4 页可参与合并。 */
export function isMergeable(record) {
  return record.pages.some(
    (page) => (page.kind === 'A5' || page.kind === 'A4') && isPageIncluded(record, page)
  );
}

/**
 * 按类别统计页数：
 * - A5 / A4 / skip 仅统计未删除的页面；
 * - excluded 为已删除页数（含原本可合并与不可合并的页面）。
 */
export function countKinds(record) {
  const counts = { A5: 0, A4: 0, skip: 0, excluded: 0 };
  for (const page of record.pages) {
    if (!isPageIncluded(record, page)) {
      counts.excluded += 1;
      continue;
    }
    counts[page.kind] += 1;
  }
  return counts;
}

/** 单页分类：先取有效盒，再按宽度/高度阈值判定 A5 / A4 / skip。 */
function classifyPage(page, index) {
  const box = effectiveBox(page);
  if (!box) {
    return { index, kind: 'skip', reason: '无法读取页面尺寸', w: 0, h: 0, box: null };
  }
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  if (w > WIDTH_LIMIT) {
    return { index, kind: 'skip', reason: '超出 A4 宽度', w, h, box };
  }
  return { index, kind: h < HALF_HEIGHT_LIMIT ? 'A5' : 'A4', w, h, box };
}

/**
 * 有效页面盒：MediaBox ∩ CropBox。
 * MediaBox 包含 CropBox 时直接用 MediaBox；否则取交集；交集为空时回退 MediaBox。
 */
function effectiveBox(page) {
  let media;
  try {
    media = readRect(page.node.MediaBox());
  } catch {
    return null;
  }
  if (!media) return null;

  let crop = null;
  try {
    crop = readRect(page.node.CropBox());
  } catch {
    crop = null;
  }
  if (!crop) return media;

  const contains =
    media.x1 >= crop.x1 && media.y1 >= crop.y1 && media.x2 <= crop.x2 && media.y2 <= crop.y2;
  if (contains) return media;

  const box = {
    x1: Math.max(media.x1, crop.x1),
    y1: Math.max(media.y1, crop.y1),
    x2: Math.min(media.x2, crop.x2),
    y2: Math.min(media.y2, crop.y2)
  };
  if (box.x2 <= box.x1 || box.y2 <= box.y1) return media;
  return box;
}

/** 读取 4 元素矩形数组并规范化坐标顺序；元素非数字返回 null。 */
function readRect(array) {
  if (!(array instanceof PDFArray) || array.size() !== 4) return null;
  const numbers = [];
  for (let i = 0; i < 4; i++) {
    const value = array.lookup(i, PDFNumber); // 类型不符时抛错，由调用方 try/catch
    numbers.push(value.asNumber());
  }
  let [x1, y1, x2, y2] = numbers;
  if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) return null;
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  return { x1, y1, x2, y2 };
}
