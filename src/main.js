import './styles.css';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import {
  countKinds,
  createInvoiceRecord,
  exceedsPageLimit,
  isMergeable,
  MAX_IMPORT_PAGES,
  probePageCount,
  sha256Hex
} from './modules/invoices.js';
import { mergeInvoices } from './modules/merge.js';
import { openPdf, renderInto } from './modules/preview.js';
import { printPdf } from './modules/print.js';

// 大图弹窗最大宽度（宽屏下允许更大的预览）
const MODAL_WIDTH = 1400;

// 页面元素引用
const els = {
  dropZone: document.querySelector('#drop-zone'),
  fileInput: document.querySelector('#file-input'),
  fileList: document.querySelector('#file-list'),
  nextBtn: document.querySelector('#next-btn'),
  backBtn1: document.querySelector('#back-btn-1'),
  backBtn2: document.querySelector('#back-btn-2'),
  mergeBtn: document.querySelector('#merge-btn'),
  clearBtn: document.querySelector('#clear-btn'),
  mergeSummary: document.querySelector('#merge-summary'),
  status: document.querySelector('#status'),
  importCard: document.querySelector('#import-card'),
  mergeCard: document.querySelector('#merge-card'),
  resultCard: document.querySelector('#result-card'),
  resultPages: document.querySelector('#result-pages'),
  downloadBtn: document.querySelector('#download-btn'),
  printBtn: document.querySelector('#print-btn'),
  modal: document.querySelector('#modal'),
  modalTitle: document.querySelector('#modal-title'),
  modalCanvas: document.querySelector('#modal-canvas'),
  modalClose: document.querySelector('#modal-close'),
  printRoot: document.querySelector('#print-root')
};

// 顶部步骤条（向导）
const stepItems = Array.from(document.querySelectorAll('.step-item'));
let currentStep = 1;

// 应用状态：导入记录列表 + 当前合并结果（bytes/name/pdfDoc）
const state = { records: [], merged: null };

function setStatus(text) {
  els.status.textContent = text;
}

/** 文件大小人性化显示（B / KB / MB）。 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 某步骤是否可进入：1 恒可；2 需有可合并文件；3 需已有合并结果。 */
function canGo(step) {
  if (step === 1) return true;
  if (step === 2) return state.records.some(isMergeable);
  if (step === 3) return Boolean(state.merged);
  return false;
}

/** 显示当前步骤面板、隐藏其余面板。 */
function applyStepVisibility() {
  els.importCard.hidden = currentStep !== 1;
  els.mergeCard.hidden = currentStep !== 2;
  els.resultCard.hidden = currentStep !== 3;
}

/** 刷新步骤条：当前步高亮、已过步显示绿勾、不可达步禁用。 */
function updateStepper() {
  for (const item of stepItems) {
    const step = Number(item.dataset.step);
    const badge = item.querySelector('.step-badge');
    const reachable = canGo(step);
    const isCurrent = step === currentStep;
    const isDone = step < currentStep && reachable;
    item.classList.toggle('is-current', isCurrent);
    item.classList.toggle('is-done', isDone);
    item.disabled = !reachable || isCurrent;
    if (isCurrent) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    badge.textContent = isDone ? '✓' : String(step);
  }
}

/** 切换到指定步骤（不可达则忽略）。 */
function goToStep(step) {
  if (!canGo(step)) return;
  currentStep = step;
  if (step === 2) updateMergeSummary();
  applyStepVisibility();
  updateStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 第 2 步：生成待合并清单（按导入顺序）与预计输出统计。 */
function updateMergeSummary() {
  const container = els.mergeSummary;
  container.textContent = '';

  let a5 = 0;
  let a4 = 0;
  let excluded = 0;
  let files = 0;

  for (const record of state.records) {
    if (record.error) continue;
    const counts = countKinds(record);
    if (counts.A5 + counts.A4 + counts.skip + counts.excluded === 0) continue;
    files += 1;
    a5 += counts.A5;
    a4 += counts.A4;
    excluded += counts.excluded;

    const chip = document.createElement('div');
    const mergeable = counts.A5 + counts.A4 > 0;
    chip.className = mergeable ? 'summary-chip' : 'summary-chip is-muted';

    const index = document.createElement('span');
    index.className = 'chip-index';
    index.textContent = String(files);

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = record.name;
    name.title = record.name;

    chip.append(index, name);
    if (counts.A5 > 0) chip.append(badge(`A5 ×${counts.A5}`, 'a5', false));
    if (counts.A4 > 0) chip.append(badge(`A4 ×${counts.A4}`, 'a4', false));
    if (counts.skip > 0) chip.append(badge(`跳过 ×${counts.skip}`, 'skip', false));
    if (counts.excluded > 0) chip.append(badge(`已删 ×${counts.excluded}`, 'del', false));
    container.append(chip);
  }

  const sheets = Math.ceil(a5 / 2) + a4;
  const meta = document.createElement('p');
  meta.className = 'summary-meta';
  meta.textContent =
    files === 0
      ? '没有可合并的文件'
      : `共 ${files} 个文件 · A5 ${a5} 页、A4 ${a4} 页 → 预计输出 ${sheets} 张 A4` +
        (excluded > 0 ? ` · 已删 ${excluded} 页` : '');
  container.prepend(meta);
}

/**
 * 根据当前状态刷新各按钮可用性，并同步向导步骤：
 * 状态失效时自动退回（结果被作废退回第 2 步，无文件退回第 1 步）。
 */
function updateButtons() {
  const hasRecords = state.records.length > 0;
  const mergeable = state.records.some(isMergeable);
  els.nextBtn.disabled = !mergeable;
  els.mergeBtn.disabled = !mergeable;
  els.clearBtn.disabled = !hasRecords;
  // 结果字节编辑期间（mergedBusy）同步锁定下载/打印，防止导出过期内容
  els.downloadBtn.disabled = !state.merged || mergedBusy;
  els.printBtn.disabled = !state.merged || mergedBusy;

  if (!canGo(currentStep)) currentStep = canGo(2) ? 2 : 1;
  applyStepVisibility();
  updateStepper();
}

/**
 * 使合并结果失效：销毁 pdf.js 句柄、隐藏结果卡片。
 * 在导入新文件、移除文件、清空、重新合并前调用，防止引用过期字节。
 */
function invalidateMerged() {
  if (state.merged) {
    if (state.merged.pdfDoc) {
      try {
        state.merged.pdfDoc.destroy();
      } catch {
        /* noop */
      }
    }
    state.merged = null;
  }
  els.resultCard.hidden = true;
  els.resultPages.textContent = '';
}

/** 汇总所有记录的分类统计，生成状态栏文本。 */
function summaryText() {
  let files = 0;
  let a5 = 0;
  let a4 = 0;
  let skip = 0;
  let excluded = 0;
  for (const record of state.records) {
    if (record.error) continue;
    files += 1;
    const counts = countKinds(record);
    a5 += counts.A5;
    a4 += counts.A4;
    skip += counts.skip;
    excluded += counts.excluded;
  }
  const total = a5 + a4;
  const deletedNote = excluded > 0 ? `，已删 ${excluded} 页` : '';
  if (files === 0) return '没有可读取的文件，请重新导入';
  if (total === 0) return `已导入 ${files} 个文件，但没有可合并的页面（文件可能损坏、超出 A4 尺寸或已被全部删除）`;
  return `已导入 ${files} 个文件：A5 ${a5} 页、A4 ${a4} 页、跳过 ${skip} 页${deletedNote}。点击「下一步：合并」。`;
}

/** 生成统计徽章元素。 */
function badge(text, kind, zero) {
  const span = document.createElement('span');
  span.className = `badge badge-${kind}${zero ? ' is-zero' : ''}`;
  span.textContent = text;
  return span;
}

// —— 合并结果编辑：按 pdf-lib 字节修改（删除/重排），pdf.js 句柄用于渲染 ——
let mergedBusy = false; // 结果编辑串行锁，避免并发 load/save 造成状态错乱

/** 生成结果页 figure（canvas + 标签 + 删除按钮，可点击放大、可拖拽排序）。 */
function resultFigure(pdfDoc, index, pageCount) {
  const figure = document.createElement('figure');
  figure.className = 'thumb';
  figure.tabIndex = 0; // 支持键盘聚焦回车放大
  figure.draggable = true; // 支持拖拽排序
  figure.dataset.page = String(index);

  const canvas = document.createElement('canvas');

  const figcaption = document.createElement('figcaption');
  const tagSpan = document.createElement('span');
  tagSpan.className = 'tag tag-merged';
  tagSpan.textContent = 'A4';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'tag-label';
  labelSpan.textContent = `${index}/${pageCount}`;
  figcaption.append(tagSpan, labelSpan);

  const remove = document.createElement('button');
  remove.className = 'btn-remove';
  remove.type = 'button';
  remove.title = `删除第 ${index} 页`;
  remove.setAttribute('aria-label', `删除第 ${index} 页`);
  remove.textContent = '×';
  // 索引在点击时从 DOM 实时计算，拖拽重排后无需重绑监听
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteResultPage(figureIndex(figure));
  });

  const open = () => {
    // 索引实时取自 DOM：拖拽重排后点击的始终是当前看到的页
    const current = figureIndex(figure);
    openModal(pdfDoc, current, `合并结果 · 第 ${current} 页`);
  };
  figure.addEventListener('click', open);
  figure.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') open();
  });

  figure.append(canvas, figcaption, remove);
  return figure;
}

/**
 * 修改合并结果字节的通用流程：
 * load（pdf-lib）→ mutator 修改 → save → 更新 state.merged.bytes；
 * reopen 时重建 pdf.js 句柄（保证大图弹窗页码与字节一致），
 * rerender 时按新页数整页重渲染缩略图（页数变化的删除操作需要）；
 * 失败时尽力按当前字节重建渲染，保持预览与字节一致。
 */
async function editMergedPages(mutator, { reopen, rerender, message }) {
  if (!state.merged || mergedBusy) return;
  mergedBusy = true;
  updateButtons(); // 期间禁用下载/打印
  try {
    setStatus('正在更新页面…');
    const libDoc = await PDFDocument.load(state.merged.bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    await mutator(libDoc);
    if (libDoc.getPageCount() === 0) {
      invalidateMerged();
      setStatus('页面已全部删除，请返回上一步重新合并');
      return;
    }
    const bytes = await libDoc.save({ useObjectStreams: false });
    state.merged.bytes = bytes;
    if (reopen) {
      try {
        state.merged.pdfDoc.destroy();
      } catch {
        /* noop */
      }
      state.merged.pdfDoc = await openPdf(bytes);
    }
    if (rerender) await renderResult();
    setStatus(message(libDoc.getPageCount()));
  } catch (error) {
    setStatus(`页面更新失败：${error && error.message ? error.message : error}`);
    // 尽力把预览恢复到与字节一致的状态
    if (state.merged) {
      try {
        state.merged.pdfDoc.destroy();
      } catch {
        /* noop */
      }
      try {
        state.merged.pdfDoc = await openPdf(state.merged.bytes);
        await renderResult();
      } catch {
        /* noop */
      }
    }
  } finally {
    mergedBusy = false;
    updateButtons();
  }
}

/** 删除合并结果中的指定页（1 起，按当前预览顺序）。 */
function deleteResultPage(index) {
  if (mergedBusy) return;
  editMergedPages((doc) => doc.removePage(index - 1), {
    reopen: true,
    rerender: true,
    message: (count) => `已删除第 ${index} 页（剩余 ${count} 页），下载与打印按当前预览输出`
  });
}

/**
 * 将合并结果的第 from 页移动到第 to 位（均按当前顺序的 1 起索引）。
 * pdf-lib 无 movePage：直接操作页面树根节点（/Pages）的 /Kids 引用数组实现重排
 * （/Kids 位于 /Pages 节点而非文档目录，数组元素为各页的间接引用）。
 */
function moveResultPage(from, to) {
  if (mergedBusy || from === to) return;
  editMergedPages(
    (doc) => {
      const catalog = doc.context.lookup(doc.context.trailerInfo.Root);
      const pagesNode = catalog.lookup(PDFName.of('Pages'));
      const kids = pagesNode.get(PDFName.of('Kids'));
      if (!(kids instanceof PDFArray) || kids.size() !== doc.getPageCount()) {
        throw new Error('该文档的页面结构不支持重排');
      }
      const ref = kids.get(from - 1);
      kids.remove(from - 1);
      kids.insert(to - 1, ref);
    },
    {
      // 页数与画面不变：仅重建句柄使大图弹窗页码与新顺序一致，缩略图 DOM 已由拖拽即时调整
      reopen: true,
      rerender: false,
      message: () => `已调整页面顺序（第 ${from} 页 → 第 ${to} 位），下载与打印按当前顺序输出`
    }
  );
}

/** 取结果页 figure 在网格中的当前序号（1 起）。 */
function figureIndex(figure) {
  return Array.from(els.resultPages.children).indexOf(figure) + 1;
}

/** 按数据页码同步结果页标签与 dataset（删除/移动后刷新编号）。 */
function renumberResult() {
  const figures = Array.from(els.resultPages.children);
  for (let i = 0; i < figures.length; i++) {
    const figure = figures[i];
    const index = i + 1;
    figure.dataset.page = String(index);
    const label = figure.querySelector('.tag-label');
    if (label) label.textContent = `${index}/${figures.length}`;
    const remove = figure.querySelector('.btn-remove');
    if (remove) {
      remove.title = `删除第 ${index} 页`;
      remove.setAttribute('aria-label', `删除第 ${index} 页`);
    }
  }
}

/** 重建卡片头部的分类徽章（删除/恢复页面后统计会变化）。 */
function renderHeadBadges(record) {
  if (!record.head) return;
  for (const el of record.head.querySelectorAll('.badge')) el.remove();
  if (record.error) return;
  const counts = countKinds(record);
  record.head.append(badge(`A5 ×${counts.A5}`, 'a5', counts.A5 === 0));
  record.head.append(badge(`A4 ×${counts.A4}`, 'a4', counts.A4 === 0));
  if (counts.skip > 0) record.head.append(badge(`跳过 ×${counts.skip}`, 'skip', false));
  if (counts.excluded > 0) record.head.append(badge(`已删 ×${counts.excluded}`, 'del', false));
  // 印章/签名外观扁平化数量（pdf-lib embedPage 不保留注解，需烘焙进内容）
  if (record.flattened > 0) record.head.append(badge(`印章/签名外观 ×${record.flattened}`, 'flat', false));
}

/** 构建单个导入文件的卡片 DOM（文件名、大小、分类徽章、页管理、移除按钮、单页预览+翻页）。 */
function renderRecordCard(record) {
  const li = document.createElement('li');
  li.className = 'file-item';
  li.dataset.id = record.id;
  li.draggable = true; // 支持拖拽排序

  const head = document.createElement('div');
  head.className = 'file-head';

  // 文件名可能包含 HTML 特殊字符，必须用 textContent 写入
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = record.name;
  name.title = record.name;

  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = formatSize(record.size);

  head.append(name, size);
  record.head = head;
  renderHeadBadges(record);

  // 页管理按钮：展开/收起逐页缩略图，删除或恢复单个页面
  if (!record.error && record.pages.length > 0) {
    const manage = document.createElement('button');
    manage.className = 'btn-manage';
    manage.type = 'button';
    manage.textContent = '页';
    manage.title = '删除 / 恢复页面';
    manage.setAttribute('aria-label', `管理 ${record.name} 的页面`);
    manage.addEventListener('click', () => togglePagePicker(record));
    head.appendChild(manage);
    record.manageBtn = manage;
  }

  const remove = document.createElement('button');
  remove.className = 'btn-remove';
  remove.type = 'button';
  remove.title = '移除';
  remove.setAttribute('aria-label', `移除 ${record.name}`);
  remove.textContent = '×';
  remove.addEventListener('click', () => removeRecord(record.id));
  head.appendChild(remove);

  record.card = li;
  li.append(head);

  if (record.error) {
    // 读取失败的文件不创建预览区，仅展示错误信息
    const errorEl = document.createElement('p');
    errorEl.className = 'file-error';
    errorEl.textContent = `无法读取：${record.error}`;
    li.appendChild(errorEl);
    els.fileList.appendChild(li);
    return;
  }

  // —— 单页预览区：左右翻页按钮 + 当前页标签 + 页类型 + 画布 ——
  const preview = document.createElement('div');
  preview.className = 'file-preview';

  const pager = document.createElement('div');
  pager.className = 'pager';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn-page';
  prevBtn.type = 'button';
  prevBtn.textContent = '‹';
  prevBtn.setAttribute('aria-label', '上一页');

  const pageLabel = document.createElement('span');
  pageLabel.className = 'page-label';

  const kindTag = document.createElement('span');
  kindTag.className = 'tag tag-skip';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-page';
  nextBtn.type = 'button';
  nextBtn.textContent = '›';
  nextBtn.setAttribute('aria-label', '下一页');

  prevBtn.addEventListener('click', () => {
    if (record.previewPage > 1) {
      record.previewPage -= 1;
      renderPreview(record);
    }
  });
  nextBtn.addEventListener('click', () => {
    if (record.pdfDoc && record.previewPage < record.pdfDoc.numPages) {
      record.previewPage += 1;
      renderPreview(record);
    }
  });

  pager.append(prevBtn, pageLabel, kindTag, nextBtn);

  const canvas = document.createElement('canvas');
  canvas.className = 'preview-canvas';
  canvas.tabIndex = 0;
  const open = () =>
    openModal(record.pdfDoc, record.previewPage, `${record.name} · 第 ${record.previewPage} 页`);
  canvas.addEventListener('click', open);
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') open();
  });

  // 预览框：宽度铺满卡片、高度按 A5 横向比例由 CSS aspect-ratio 自适应，画布在框内居中
  const frame = document.createElement('div');
  frame.className = 'preview-frame';
  frame.appendChild(canvas);

  preview.append(pager, frame);
  record.preview = { prevBtn, nextBtn, pageLabel, kindTag, canvas, frame };
  li.append(preview);

  // —— 页管理区：逐页缩略图（懒加载，首次展开时创建并渲染） ——
  const picker = document.createElement('div');
  picker.className = 'page-picker';
  picker.hidden = true;
  const pickerHead = document.createElement('div');
  pickerHead.className = 'page-picker-head';
  const pickerTitle = document.createElement('span');
  pickerTitle.textContent = `页面管理（共 ${record.pages.length} 页）`;
  const pickerTip = document.createElement('span');
  pickerTip.textContent = '点击 × 删除该页，点击已删除页可恢复';
  pickerHead.append(pickerTitle, pickerTip);
  const grid = document.createElement('div');
  grid.className = 'pg-grid';
  picker.append(pickerHead, grid);
  record.picker = { root: picker, grid, built: false, cells: new Map() };
  li.append(picker);

  els.fileList.appendChild(li);
}

/** 确保已打开 pdf.js 句柄（预览与页管理共用，懒加载 + 失败可重试）。 */
async function ensureRecordPdf(record) {
  if (record.pdfDoc) return record.pdfDoc;
  record.pdfDoc = await openPdf(record.bytes);
  return record.pdfDoc;
}

/** 用 pdf.js 打开文件并渲染当前预览页。失败仅提示，不影响参与合并。 */
async function renderRecordPreview(record) {
  if (record.error) return;
  try {
    await ensureRecordPdf(record);
    await renderPreview(record);
  } catch (error) {
    record.error = `预览失败：${error && error.message ? error.message : error}`;
    showRecordPreviewError(record);
    const { prevBtn, nextBtn, pageLabel, frame } = record.preview;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    pageLabel.textContent = '--';
    frame.hidden = true; // 避免留下未渲染的空白预览框
    if (record.manageBtn) record.manageBtn.disabled = true;
  }
}

/** 更新翻页区的页类型标签（含“已删除”状态）。 */
function updatePreviewTag(record) {
  const { kindTag } = record.preview;
  const page = record.pages[record.previewPage - 1];
  const kind = page ? page.kind : 'skip';
  const excluded = record.excluded.has(record.previewPage);
  if (excluded) {
    kindTag.textContent = `P${record.previewPage} 已删除`;
    kindTag.className = 'tag tag-excluded';
    return;
  }
  kindTag.textContent = `P${record.previewPage} ${kind === 'skip' ? '跳过' : kind}`;
  kindTag.className = `tag tag-${kind}`;
}

/** 渲染记录当前预览页（翻页按钮状态、页码标签、页类型标签与画布，尺寸按预览框实测宽高自适应）。 */
async function renderPreview(record) {
  const { prevBtn, nextBtn, pageLabel, canvas, frame } = record.preview;
  const total = record.pdfDoc ? record.pdfDoc.numPages : record.pages.length;
  const current = record.previewPage;

  prevBtn.disabled = current <= 1;
  nextBtn.disabled = !record.pdfDoc || current >= total;
  pageLabel.textContent = `${current}/${total}`;
  updatePreviewTag(record);

  if (frame.hidden) return;
  // 按预览框实际宽高适配：宽屏卡片更宽 → 预览更大；窄屏自动缩小
  const maxWidth = Math.max(120, frame.clientWidth);
  const maxHeight = Math.max(90, frame.clientHeight);
  await renderInto(record.pdfDoc, current, canvas, maxWidth, maxHeight);
}

// —— 页管理：展开逐页缩略图、删除/恢复单页 ——

/** 展开/收起页管理区（首次展开时创建全部页格并渲染缩略图）。 */
async function togglePagePicker(record) {
  const picker = record.picker;
  if (!picker) return;
  const willOpen = picker.root.hidden;
  picker.root.hidden = !willOpen;
  record.pickerOpen = willOpen;
  if (!willOpen) return;

  setStatus(`正在加载 ${record.name} 的页面缩略图…`);
  try {
    const pdf = await ensureRecordPdf(record);
    if (!picker.built) {
      await buildPickerCells(record, pdf);
      picker.built = true;
    } else {
      await renderPickerThumbs(record); // 再次展开时按当前格子宽度重新渲染
    }
    setStatus(`「${record.name}」共 ${pdf.numPages} 页：点击 × 删除不需要的页面`);
  } catch (error) {
    picker.root.hidden = true;
    record.pickerOpen = false;
    setStatus(`无法加载页面缩略图：${error && error.message ? error.message : error}`);
  }
}

/** 构建页格：每页一个 canvas + 删除/恢复按钮 + 页码/已删除角标，并逐页渲染。 */
async function buildPickerCells(record, pdf) {
  const grid = record.picker.grid;
  grid.textContent = '';
  record.picker.cells.clear();
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const cell = document.createElement('div');
    cell.className = 'pg';
    cell.dataset.page = String(pageNo);

    const canvas = document.createElement('canvas');

    const del = document.createElement('button');
    del.className = 'pg-del';
    del.type = 'button';
    const excluded = record.excluded.has(pageNo);
    del.textContent = excluded ? '↺' : '×';
    del.title = excluded ? `恢复第 ${pageNo} 页` : `删除第 ${pageNo} 页`;
    del.setAttribute('aria-label', del.title);
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      setPageExcluded(record, pageNo, !record.excluded.has(pageNo));
    });

    const no = document.createElement('span');
    no.className = 'pg-no';
    no.textContent = `P${pageNo}`;

    const x = document.createElement('span');
    x.className = 'pg-x';
    x.textContent = '已删除';

    cell.append(canvas, del, no, x);
    if (excluded) cell.classList.add('is-excluded');
    grid.appendChild(cell);
    record.picker.cells.set(pageNo, cell);

    await renderPickerThumb(record, pdf, pageNo, canvas);
  }
}

/** 渲染单个页格缩略图（按格子实测宽度适配，随容器宽度缩放）。 */
async function renderPickerThumb(record, pdf, pageNo, canvas) {
  const cell = canvas.parentElement;
  const maxWidth = Math.max(48, cell.clientWidth - 10); // 减去格子内边距与边框
  await renderInto(pdf, pageNo, canvas, maxWidth);
}

/** 重新渲染全部页格（窗口尺寸变化、格子宽度变化时调用）。 */
async function renderPickerThumbs(record) {
  const pdf = record.pdfDoc;
  if (!pdf) return;
  for (const [pageNo, cell] of record.picker.cells) {
    await renderPickerThumb(record, pdf, pageNo, cell.querySelector('canvas'));
  }
}

/** 删除/恢复单页：更新 excluded 集、页格状态、头部徽章、预览标签，并作废旧的合并结果。 */
function setPageExcluded(record, pageNo, exclude) {
  if (exclude) record.excluded.add(pageNo);
  else record.excluded.delete(pageNo);

  const cell = record.picker.cells.get(pageNo);
  if (cell) {
    cell.classList.toggle('is-excluded', exclude);
    const del = cell.querySelector('.pg-del');
    del.textContent = exclude ? '↺' : '×';
    del.title = exclude ? `恢复第 ${pageNo} 页` : `删除第 ${pageNo} 页`;
    del.setAttribute('aria-label', del.title);
  }

  renderHeadBadges(record);
  if (record.preview && record.previewPage === pageNo) updatePreviewTag(record);
  invalidateMerged(); // 页集合变化 → 旧合并结果不再对应，需重新合并
  updateButtons();

  const counts = countKinds(record);
  setStatus(
    exclude
      ? `已删除 ${record.name} 第 ${pageNo} 页（累计已删 ${counts.excluded} 页，可点 ↺ 恢复）`
      : `已恢复 ${record.name} 第 ${pageNo} 页（累计已删 ${counts.excluded} 页）`
  );
}

/** 在文件卡片上追加预览错误提示（仅追加一次）。 */
function showRecordPreviewError(record) {
  if (!record.card || record.card.querySelector('.file-error')) return;
  const errorEl = document.createElement('p');
  errorEl.className = 'file-error';
  errorEl.textContent = record.error;
  record.card.appendChild(errorEl);
}

/**
 * 导入文件（拖拽或文件选择器，支持多次追加导入）：
 * 过滤 PDF → 计算内容哈希去重 → 探测页数（超过 MAX_IMPORT_PAGES 页拒绝导入）→ 逐个加载渲染。
 */
async function addFiles(fileList) {
  const files = Array.from(fileList).filter(
    (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  );
  if (files.length === 0) {
    setStatus('未识别到有效的 PDF 文件，请重新选择');
    return;
  }

  invalidateMerged();
  const seen = new Set(state.records.map((record) => record.hash).filter(Boolean));
  const skipped = [];
  const rejected = [];

  for (const file of files) {
    const name = file.name || '未命名.pdf';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    if (seen.has(hash)) {
      skipped.push(name);
      continue;
    }

    // 页数上限检查：在打开/扁平化/渲染之前拦截，避免超大文档拖垮浏览器
    setStatus(`正在检查页数：${name} …`);
    const pageCount = await probePageCount(bytes);
    if (exceedsPageLimit(pageCount)) {
      rejected.push(`${name}（${pageCount} 页）`);
      continue; // 不记入 seen：再次选择同一文件时仍按超限原因提示
    }

    seen.add(hash);
    setStatus(`正在导入：${name} …`);
    const record = await createInvoiceRecord({ name, size: file.size ?? bytes.byteLength, bytes });
    state.records.push(record);
    renderRecordCard(record);
    updateButtons();
    await renderRecordPreview(record);
  }

  // 汇总提示：正常统计 + 跳过的重复文件 + 被拒绝的超限文件
  const notes = [];
  if (skipped.length > 0) {
    notes.push(`已跳过 ${skipped.length} 个重复文件：${skipped.join('、')}（内容与已导入文件相同）`);
  }
  if (rejected.length > 0) {
    notes.push(
      `已拒绝 ${rejected.length} 个超限文件：${rejected.join('、')}（单个 PDF 最多 ${MAX_IMPORT_PAGES} 页）`
    );
  }
  setStatus(notes.length > 0 ? `${summaryText()} ${notes.join('；')}` : summaryText());
  updateButtons();
}

/** 从列表移除单个文件。 */
function removeRecord(id) {
  const index = state.records.findIndex((record) => record.id === id);
  if (index < 0) return;
  const [record] = state.records.splice(index, 1);
  if (record.pdfDoc) {
    try {
      record.pdfDoc.destroy();
    } catch {
      /* noop */
    }
  }
  if (record.card) record.card.remove();
  invalidateMerged();
  setStatus(state.records.length > 0 ? summaryText() : '请导入待拼版的发票文件');
  updateButtons();
}

/** 清空全部导入文件与合并结果。 */
async function clearAll() {
  for (const record of state.records) {
    if (record.pdfDoc) {
      try {
        record.pdfDoc.destroy();
      } catch {
        /* noop */
      }
    }
  }
  state.records = [];
  invalidateMerged();
  els.fileList.textContent = '';
  setStatus('已清空导入列表，请重新导入待拼版文件');
  updateButtons();
}

/** 将 draggedId 的记录移动到 targetId 记录之前/之后，并同步 DOM 顺序。 */
function reorderRecords(draggedId, targetId, before) {
  const from = state.records.findIndex((record) => record.id === draggedId);
  if (from < 0) return;
  const [moved] = state.records.splice(from, 1);
  const to = state.records.findIndex((record) => record.id === targetId);
  if (to < 0) {
    state.records.push(moved);
  } else {
    state.records.splice(before ? to : to + 1, 0, moved);
  }
  afterReorder();
}

/** 将 draggedId 的记录移动到列表末尾。 */
function moveRecordToEnd(draggedId) {
  const from = state.records.findIndex((record) => record.id === draggedId);
  if (from < 0 || from === state.records.length - 1) return;
  const [moved] = state.records.splice(from, 1);
  state.records.push(moved);
  afterReorder();
}

/** 重排后的统一处理：按新顺序重挂 DOM、使旧合并结果失效、更新状态。 */
function afterReorder() {
  for (const record of state.records) {
    els.fileList.appendChild(record.card);
  }
  invalidateMerged();
  setStatus(`${summaryText()}（顺序已调整，重新合并将按新顺序生成）`);
  updateButtons();
}

/** 执行合并：调用 merge.js，成功后渲染结果缩略图并使下载/打印可用。 */
async function doMerge() {
  if (!state.records.some(isMergeable)) return;
  els.mergeBtn.disabled = true;
  els.printBtn.disabled = true;
  invalidateMerged();

  try {
    setStatus('正在合并…');
    const merged = await mergeInvoices(state.records, async (text) => setStatus(text));
    const pdfDoc = await openPdf(merged.bytes);
    state.merged = { bytes: merged.bytes, name: merged.name, pdfDoc };
    goToStep(3); // 合并成功自动进入结果步骤
    await renderResult();
    setStatus(`合并完成，共 ${merged.pageCount} 页：${merged.name}（可删除或拖拽调整页面顺序）`);
  } catch (error) {
    setStatus(`合并失败：${error && error.message ? error.message : error}`);
  } finally {
    updateButtons();
  }
}

/** 渲染合并结果所有页面的缩略图（尺寸按网格单元实测宽度自适应，可点击放大、删除、拖拽排序）。 */
async function renderResult() {
  els.resultPages.textContent = '';
  const { pdfDoc } = state.merged;
  const pageCount = pdfDoc.numPages;
  for (let i = 1; i <= pageCount; i++) {
    const figure = resultFigure(pdfDoc, i, pageCount);
    els.resultPages.appendChild(figure);
    const canvas = figure.querySelector('canvas');
    // 单元格随容器宽度拉伸，画布按实测宽度渲染以消除两侧留白
    const maxWidth = Math.max(140, figure.clientWidth - 14); // 减去 padding 与边框
    await renderInto(pdfDoc, i, canvas, maxWidth);
  }
}

/** 下载合并结果：Blob + 临时 <a download> 触发浏览器下载。 */
function doDownload() {
  if (!state.merged) return;
  const blob = new Blob([state.merged.bytes], { type: 'application/pdf' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = state.merged.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  setStatus(`已开始下载：${state.merged.name}`);
}

/** 调起打印（系统对话框选打印机；浏览器无法枚举打印机列表）。 */
async function doPrint() {
  if (!state.merged) return;
  els.printBtn.disabled = true;
  setStatus('正在准备打印…');
  try {
    const mode = await printPdf(state.merged.bytes);
    setStatus(
      mode === 'native'
        ? '已调起系统打印对话框，请选择打印机（纸张 A4、缩放 100%、边距无）。'
        : '已切换到图片打印模式，请在对话框中选择打印机（纸张 A4、缩放 100%、边距无）。'
    );
  } catch (error) {
    setStatus(`打印失败：${error && error.message ? error.message : error}`);
  } finally {
    updateButtons(); // 恢复为当前状态应有的按钮可用性
  }
}

/** 打开大图预览弹窗并渲染指定页。 */
async function openModal(pdfDoc, pageNumber, title) {
  els.modalTitle.textContent = title;
  els.modal.hidden = false;
  document.body.classList.add('modal-open'); // 锁定背景滚动
  const maxCanvas = Math.min(MODAL_WIDTH, window.innerWidth - 80);
  try {
    await renderInto(pdfDoc, pageNumber, els.modalCanvas, maxCanvas);
  } catch {
    /* 快速切换页时旧任务被 abort 的错误可忽略 */
  }
}

function closeModal() {
  els.modal.hidden = true;
  document.body.classList.remove('modal-open');
  els.modalTitle.textContent = '';
}

// —— 事件绑定 ——

// 点击/键盘激活隐藏的文件选择器
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

// 拖拽高亮与投放处理（仅响应文件拖入，忽略卡片拖动）
els.dropZone.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  els.dropZone.classList.add('is-dragover');
});
els.dropZone.addEventListener('dragleave', () => {
  els.dropZone.classList.remove('is-dragover');
});
els.dropZone.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  els.dropZone.classList.remove('is-dragover');
  if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
});
// 阻止窗口级默认拖放行为，避免误拖时浏览器直接打开 PDF；
// 同时记录指针 Y 坐标，供拖动卡片/页面时靠近屏幕边缘自动滚动
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (draggedId || draggedPage !== null) dragPointerY = event.clientY;
});
window.addEventListener('drop', (event) => event.preventDefault());

/** 是否为“文件拖入”（拖入文件时 types 含 Files；拖动卡片只有 text/plain）。 */
function isFileDrag(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  return types.includes('Files');
}

// —— 拖拽排序（HTML5 DnD，文件卡片与结果页共用指针跟踪与自动滚动） ——
let draggedId = null; // 文件卡片拖拽：被拖记录 id
let draggedPage = null; // 结果页拖拽：被拖页的起始序号（1 起）
let dragPointerY = 0; // 指针屏幕 Y（含列表外移动），自动滚动判定用
let dragScrollTimer = null;

/** 拖动期间启动的自动滚动：指针距视口上/边缘 90px 内按距离变速滚动窗口。 */
function startDragAutoScroll() {
  if (dragScrollTimer) return;
  dragScrollTimer = setInterval(() => {
    if (!draggedId && draggedPage === null) {
      stopDragAutoScroll();
      return;
    }
    const EDGE = 90;
    if (dragPointerY > 0 && dragPointerY < EDGE) {
      window.scrollBy(0, -Math.min(30, (EDGE - dragPointerY) / 3));
    } else if (dragPointerY > window.innerHeight - EDGE) {
      window.scrollBy(0, Math.min(30, (dragPointerY - (window.innerHeight - EDGE)) / 3));
    }
  }, 40);
}

function stopDragAutoScroll() {
  if (dragScrollTimer) {
    clearInterval(dragScrollTimer);
    dragScrollTimer = null;
  }
}

els.fileList.addEventListener('dragstart', (event) => {
  // 在页管理格内按下时不启动卡片拖拽，避免误拖（页格仅用于点击删除/恢复）
  if (event.target.closest('.pg')) {
    event.preventDefault();
    return;
  }
  const item = event.target.closest('.file-item');
  if (!item) return;
  draggedId = item.dataset.id;
  dragPointerY = event.clientY;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedId);
  // 等浏览器生成拖动快照后再加淡化样式（拖动影像保持原样）
  requestAnimationFrame(() => item.classList.add('is-dragging'));
  startDragAutoScroll();
});

els.fileList.addEventListener('dragend', () => {
  draggedId = null;
  stopDragAutoScroll();
  clearDropIndicators(els.fileList);
});

els.fileList.addEventListener('dragover', (event) => {
  if (!draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDropIndicators(els.fileList);
  const item = event.target.closest('.file-item');
  if (!item) {
    // 列表空白区（行内空位/网格下方）→ 指示“移到末尾”
    markEndDropTarget();
    return;
  }
  if (item.dataset.id === draggedId) return;
  // 按鼠标在卡片内的上下半区指示插入位置
  const rect = item.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  item.classList.add(before ? 'is-drop-before' : 'is-drop-after');
});

els.fileList.addEventListener('drop', (event) => {
  if (!draggedId) return;
  event.preventDefault();
  stopDragAutoScroll();
  clearDropIndicators(els.fileList);
  const item = event.target.closest('.file-item');
  if (!item) {
    // 投放到列表空白区域 → 移到末尾
    moveRecordToEnd(draggedId);
    draggedId = null;
    return;
  }
  const targetId = item.dataset.id;
  if (targetId === draggedId) {
    draggedId = null;
    return;
  }
  const rect = item.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  reorderRecords(draggedId, targetId, before);
  draggedId = null;
});

/** 在最后一张卡片上显示“移到末尾”指示（空白区域投放时）。 */
function markEndDropTarget() {
  const last = els.fileList.lastElementChild;
  if (last && last.classList.contains('file-item')) {
    last.classList.add('is-drop-after');
  }
}

// —— 结果页拖拽排序（交互与文件列表一致：半区指示、空白区移到末尾、边缘自动滚动） ——
els.resultPages.addEventListener('dragstart', (event) => {
  const figure = event.target.closest('.thumb');
  if (!figure || mergedBusy) return;
  draggedPage = figureIndex(figure);
  dragPointerY = event.clientY;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', figure.dataset.page);
  // 等浏览器生成拖动快照后再加淡化样式（拖动影像保持原样）
  requestAnimationFrame(() => figure.classList.add('is-dragging'));
  startDragAutoScroll();
});

els.resultPages.addEventListener('dragend', () => {
  draggedPage = null;
  stopDragAutoScroll();
  clearDropIndicators(els.resultPages);
});

els.resultPages.addEventListener('dragover', (event) => {
  if (draggedPage === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDropIndicators(els.resultPages);
  const figure = event.target.closest('.thumb');
  if (!figure) {
    // 网格空白区 → 指示“移到末尾”
    const last = els.resultPages.lastElementChild;
    if (last) last.classList.add('is-drop-after');
    return;
  }
  if (figureIndex(figure) === draggedPage) return;
  // 按鼠标在单元格内的上下半区指示插入位置
  const rect = figure.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  figure.classList.add(before ? 'is-drop-before' : 'is-drop-after');
});

els.resultPages.addEventListener('drop', (event) => {
  if (draggedPage === null) return;
  event.preventDefault();
  stopDragAutoScroll();
  clearDropIndicators(els.resultPages);
  const from = draggedPage;
  draggedPage = null;
  if (mergedBusy) return;

  const figures = Array.from(els.resultPages.children);
  const target = event.target.closest('.thumb');
  let node;
  if (!target) {
    // 投放到网格空白区 → 移到末尾
    node = figures[from - 1];
    els.resultPages.appendChild(node);
  } else {
    const targetIndex = figureIndex(target);
    if (targetIndex === from) return;
    node = figures[from - 1];
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (before) els.resultPages.insertBefore(node, target);
    else els.resultPages.insertBefore(node, target.nextSibling);
  }

  const to = figureIndex(node);
  if (to === from) return;

  // 先按新顺序调整 DOM 与编号，再持久化到 PDF 字节（失败时 editMergedPages 会按字节重建渲染）
  renumberResult();
  moveResultPage(from, to);
});

/** 清除指定容器内的拖拽指示与淡化样式（不传则清除文件列表）。 */
function clearDropIndicators(container) {
  const root = container || els.fileList;
  for (const el of root.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after')) {
    el.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
  }
}

// 文件选择器变更（value 置空以便重复选择同一文件）
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files && els.fileInput.files.length > 0) {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  }
});

els.mergeBtn.addEventListener('click', doMerge);
els.clearBtn.addEventListener('click', clearAll);
els.downloadBtn.addEventListener('click', doDownload);
els.printBtn.addEventListener('click', doPrint);

// 向导导航：下一步 / 上一步 / 点击步骤条
els.nextBtn.addEventListener('click', () => goToStep(2));
els.backBtn1.addEventListener('click', () => goToStep(1));
els.backBtn2.addEventListener('click', () => goToStep(2));
for (const item of stepItems) {
  item.addEventListener('click', () => goToStep(Number(item.dataset.step)));
}
els.modalClose.addEventListener('click', closeModal);
// 点击遮罩关闭弹窗
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) closeModal();
});
// Esc 关闭弹窗
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.modal.hidden) closeModal();
});

// 图片打印模式结束后清理 #print-root（双保险，print.js 内也注册了 afterprint）
window.addEventListener('afterprint', () => {
  els.printRoot.textContent = '';
});

// —— 窗口尺寸变化：按新容器宽度重渲染当前可见的缩略图（预览智能适配宽窄屏） ——
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderVisibleThumbs, 250);
});

async function rerenderVisibleThumbs() {
  if (mergedBusy) return;
  if (currentStep === 1) {
    for (const record of state.records) {
      if (record.error || !record.preview) continue;
      if (!record.preview.frame.hidden && record.pdfDoc) await renderPreview(record);
      if (record.pickerOpen && record.picker.built) await renderPickerThumbs(record);
    }
  } else if (currentStep === 3 && state.merged) {
    await renderResult();
  }
}

// 初始状态与版权年份
setStatus('请导入待拼版的发票文件（支持多选、批量与拖拽）');
const yearEl = document.querySelector('#copyright-year');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
updateButtons();
