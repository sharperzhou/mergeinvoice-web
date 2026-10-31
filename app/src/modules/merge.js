import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { isPageIncluded } from './invoices.js';

// A4 页面尺寸（pt）与裁剪标记参数
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const CUT_MARK_LENGTH = 10; // 标记线段长度
const CUT_MARK_MARGIN = 50; // A4 整页底部裁剪线的余量阈值（h+50 < 页高 才画）

/**
 * 合并发票，输出一个新 PDF：
 * - A5 页两两配对拼到同一张 A4 上半/下半（下半张旋转 180°），中线画裁剪标记；
 *   奇数张时最后一张单独占一页，仍画中线标记；
 * - A4 整页每页占一张 A4，仅当页面高度不足整页（h+50 < 841.89）时在内容底部画裁剪线；
 * - 超宽（skip）页不参与合并；输出顺序：所有 A5 页在前，A4 页在后，保持导入顺序。
 *
 * @param {Array} records loadInvoiceFile 生成的记录数组
 * @param {Function} [onProgress] 可选进度回调（async），在每个批次间触发以刷新 UI
 * @returns {Promise<{bytes: Uint8Array, name: string, pageCount: number}>}
 */
export async function mergeInvoices(records, onProgress) {
  const a5Entries = [];
  const a4Entries = [];

  for (const record of records) {
    if (!record.doc) continue;
    for (const page of record.pages) {
      // 用户在列表中删除的页面不参与合并
      if (!isPageIncluded(record, page)) continue;
      if (page.kind === 'A5') a5Entries.push({ record, page });
      else if (page.kind === 'A4') a4Entries.push({ record, page });
    }
  }

  if (a5Entries.length === 0 && a4Entries.length === 0) {
    throw new Error('没有可合并的发票页面');
  }

  const output = await PDFDocument.create();
  // 同一源页多次引用时只嵌入一次（页对象号 → 嵌入页）
  const embedded = new Map();

  // 嵌入时按有效盒裁剪（left/bottom/right/top），排除 MediaBox 中被 CropBox 排除的区域
  const embed = async (entry) => {
    const key = `${entry.record.id}:${entry.page.index}`;
    if (embedded.has(key)) return embedded.get(key);
    const result = await output.embedPage(entry.record.doc.getPage(entry.page.index), {
      left: entry.page.box.x1,
      bottom: entry.page.box.y1,
      right: entry.page.box.x2,
      top: entry.page.box.y2
    });
    embedded.set(key, result);
    return result;
  };

  // —— A5 两拼 ——
  // i+=2 节奏：每轮消耗 0~2 个条目
  for (let i = 0; i < a5Entries.length; i++) {
    const sheet = output.addPage([A4_WIDTH, A4_HEIGHT]);

    // 上半张：水平居中、顶对齐
    const first = a5Entries[i];
    const firstEmbed = await embed(first);
    sheet.drawPage(firstEmbed, {
      x: (A4_WIDTH - first.page.w) / 2,
      y: A4_HEIGHT - first.page.h,
      width: first.page.w,
      height: first.page.h
    });
    drawCutMarks(sheet, A4_HEIGHT / 2);
    await notify(onProgress, `正在合并 A5 发票 ${Math.min(i + 1, a5Entries.length)}/${a5Entries.length}…`);

    // 最后一张为奇数时单独成页
    if (i === a5Entries.length - 1) break;

    // 下半张：旋转 180°。pdf-lib 的 drawPage 以 (x,y) 为旋转锚点（左下角），
    // 因此传 x=居中位置+页宽、y=页高，使旋转后图像恰好落在页面下半区域。
    i += 1;
    const second = a5Entries[i];
    const secondEmbed = await embed(second);
    sheet.drawPage(secondEmbed, {
      x: (A4_WIDTH - second.page.w) / 2 + second.page.w,
      y: second.page.h,
      width: second.page.w,
      height: second.page.h,
      rotate: degrees(180)
    });
  }

  // —— A4 整页 ——
  for (let i = 0; i < a4Entries.length; i++) {
    const entry = a4Entries[i];
    const sheet = output.addPage([A4_WIDTH, A4_HEIGHT]);
    const embeddedPage = await embed(entry);
    sheet.drawPage(embeddedPage, {
      x: (A4_WIDTH - entry.page.w) / 2,
      y: A4_HEIGHT - entry.page.h,
      width: entry.page.w,
      height: entry.page.h
    });
    // 内容高度不足整页时，在内容底部画一条裁剪提示线
    if (entry.page.h + CUT_MARK_MARGIN < A4_HEIGHT) {
      drawCutMarks(sheet, A4_HEIGHT - entry.page.h);
    }
    await notify(onProgress, `正在加入 A4 发票 ${i + 1}/${a4Entries.length}…`);
  }

  // useObjectStreams:false：生成结构更直观、兼容性更好的普通交叉引用表
  const bytes = await output.save({ useObjectStreams: false });
  return { bytes, name: mergedFileName(), pageCount: output.getPageCount() };
}

/** 输出文件名：合并发票yyyyMMddHHmmss.pdf。 */
export function mergedFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`;
  return `合并发票${stamp}.pdf`;
}

/** 进度回调 + 让出主线程，确保浏览器有机会刷新状态文本。 */
async function notify(onProgress, text) {
  if (!onProgress) return;
  await onProgress(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 在给定 y 处画左右两条裁剪标记（页面左右边缘各一段 10pt 水平黑线），
 * 左 x 10→20，右 W-10→W-20，线宽 1pt。
 */
function drawCutMarks(page, y) {
  const style = { thickness: 1, color: rgb(0, 0, 0) };
  page.drawLine({
    start: { x: CUT_MARK_LENGTH, y },
    end: { x: CUT_MARK_LENGTH * 2, y },
    ...style
  });
  page.drawLine({
    start: { x: A4_WIDTH - CUT_MARK_LENGTH, y },
    end: { x: A4_WIDTH - CUT_MARK_LENGTH * 2, y },
    ...style
  });
}
