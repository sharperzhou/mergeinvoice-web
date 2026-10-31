import {
  createInvoiceRecord,
  exceedsPageLimit,
  probePageCount,
  sha256Hex,
  MAX_IMPORT_PAGES
} from './invoices.js';

/**
 * 通用导入管道（文件选择 / 拖拽 / ZIP 解压 / 邮件附件四条来源共用）：
 * 内容哈希去重 → 页数上限检查 → 创建发票记录。
 *
 * 输入 entries 为 [{ name, bytes, size? }]，纯逻辑无 DOM，便于 node --test 覆盖；
 * UI 侧通过回调接入：
 * - onStatus(text)：进度提示（检查页数 / 导入中）；
 * - onRecord(record)：单条记录创建后立即渲染（边导入边可见），抛错会中断整体导入。
 *
 * 返回 { records, skipped, rejected, notes }：
 * - skipped 重复被跳过的文件名；rejected 超出 MAX_IMPORT_PAGES 被拒绝的「名称（N 页）」；
 * - notes 为汇总提示文本（无内容时为空串），调用方可拼在总统计之后。
 */
export async function importEntries(entries, { existingHashes = [], onStatus, onRecord } = {}) {
  const seen = new Set(existingHashes.filter(Boolean));
  const records = [];
  const skipped = [];
  const rejected = [];

  for (const entry of entries) {
    const name = entry.name || '未命名.pdf';
    const bytes = entry.bytes;
    const hash = await sha256Hex(bytes);
    if (seen.has(hash)) {
      skipped.push(name);
      continue;
    }

    // 页数上限检查：在打开/扁平化/渲染之前拦截，避免超大文档拖垮浏览器
    if (onStatus) onStatus(`正在检查页数：${name} …`);
    const pageCount = await probePageCount(bytes);
    if (exceedsPageLimit(pageCount)) {
      rejected.push(`${name}（${pageCount} 页）`);
      continue; // 不记入 seen：再次选择同一文件时仍按超限原因提示
    }

    seen.add(hash);
    if (onStatus) onStatus(`正在导入：${name} …`);
    const record = await createInvoiceRecord({
      name,
      size: typeof entry.size === 'number' ? entry.size : bytes.byteLength,
      bytes
    });
    records.push(record);
    if (onRecord) await onRecord(record);
  }

  return { records, skipped, rejected, notes: buildImportNotes(skipped, rejected) };
}

/** 汇总提示片段：重复跳过 + 超限拒绝（无则空串）。 */
function buildImportNotes(skipped, rejected) {
  const notes = [];
  if (skipped.length > 0) {
    notes.push(`已跳过 ${skipped.length} 个重复文件：${skipped.join('、')}（内容与已导入文件相同）`);
  }
  if (rejected.length > 0) {
    notes.push(
      `已拒绝 ${rejected.length} 个超限文件：${rejected.join('、')}（单个 PDF 最多 ${MAX_IMPORT_PAGES} 页）`
    );
  }
  return notes.join('；');
}
