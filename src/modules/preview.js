// 兼容补丁必须先于 pdf.js 执行（旧版移动端浏览器缺少 Promise.withResolvers 等 API）
import './polyfills.js';
import * as pdfjsLib from 'pdfjs-dist';
// 自定义 Worker 入口（内部先注入补丁再加载 pdf.js worker），以 ES module 形式打包后取 URL
import workerUrl from '../pdf-worker.js?worker&url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js 运行时资源前缀：vite-plugin-static-copy 把 cmaps 等复制到 <base>/pdfjs/ 下。
// useWorkerFetch 开启时 worker 用 fetch(相对路径) 拉 cMap/wasm，相对路径会按 worker
// 脚本所在目录解析（如 /assets/）导致 404 → 中文 CID 字体映射失败、预览丢字。
// 因此在主线程先拼成绝对 URL 再传给 pdf.js。
const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

// 每个 canvas 上正在执行的渲染任务，用于快速翻页时先 abort 旧任务再启动新任务
const renderTasks = new WeakMap();

/**
 * 用 pdf.js 打开 PDF。
 * 注意：pdf.js 会持有并可能转移 data 的底层缓冲区，
 * 因此这里传 bytes.slice(0) 的副本，避免影响 pdf-lib 侧的原始字节。
 */
export function openPdf(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: `${assetBase}cmaps/`, // 中文 CID 字体映射表
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`, // 14 种标准字体
    wasmUrl: `${assetBase}wasm/`, // 部分解码器（如 JBIG2）需要
    iccUrl: `${assetBase}iccs/` // ICC 色彩配置
  }).promise;
}

/**
 * 将 PDF 某页渲染到指定 canvas：
 * - 按 maxWidth（及可选 maxHeight）计算适配缩放比，任一方向超限即整体缩小；
 * - 高分屏（devicePixelRatio>1）用 transform 放大画布保证清晰；
 * - 同一 canvas 的上一次渲染未完成时先 abort，避免 "canvas in use" 报错。
 */
export async function renderInto(pdf, pageNumber, canvas, maxWidth, maxHeight) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(
    0.1,
    Math.min(maxWidth / base.width, maxHeight !== undefined ? maxHeight / base.height : Infinity)
  );
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));

  // 中止上一次渲染并等待其真正结束
  const previous = renderTasks.get(canvas);
  if (previous) {
    try {
      previous.abort();
    } catch {
      /* 任务已结束时 abort 可能抛错，忽略 */
    }
    await previous.promise.catch(() => {});
  }

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);

  // dpr>1 时通过 transform 等效放大渲染，比直接放大 viewport 更省内存
  const task = page.render({
    canvasContext: context,
    viewport,
    transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
  });
  renderTasks.set(canvas, task);
  try {
    await task.promise;
  } finally {
    if (renderTasks.get(canvas) === task) renderTasks.delete(canvas);
  }
}
