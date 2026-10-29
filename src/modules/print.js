import { openPdf } from './preview.js';

const PRINT_DPI = 200; // 图片打印回退模式的渲染分辨率
const FALLBACK_TIMEOUT_MS = 6000; // 原生打印等待超时，超时后回退图片打印

/**
 * 打印合并结果。
 * 浏览器无法枚举本地打印机，只能调起系统打印对话框（window.print），
 * 由用户在对话框中选择打印机与纸张。
 *
 * 优先尝试在隐藏 iframe 中加载 PDF blob 调起原生打印（保留矢量与打印机驱动选项）；
 * 若 iframe 方式不可用（内嵌 PDF 查看器缺失、被策略禁用等），回退为逐页渲染 PNG 的图片打印。
 *
 * @returns {Promise<'native'|'image'>} 实际使用的打印方式
 */
export async function printPdf(bytes) {
  if (tryNativePrint(bytes)) return 'native';
  await imagePrint(bytes);
  return 'image';
}

/**
 * 隐藏 iframe 加载 PDF 并调起系统打印对话框。
 * 返回同步布尔值：false 表示立即走图片打印回退；
 * true 表示已触发打印流程（内部异步完成 resolve，失败自动回退由调用方处理不到——
 * 此处通过 Promise 在超时/焦点回调中 resolve，真正的失败会 reject 使上层回退）。
 */
function tryNativePrint(bytes) {
  try {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    // 完全隐藏但保留在 DOM 中（display:none 会导致部分浏览器不加载/不打印）
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = 'none';
    document.body.appendChild(frame);

    let settled = false;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        frame.removeEventListener('load', onLoad);
        window.removeEventListener('focus', onFocus);
        clearTimeout(fallbackTimer);
        // 延迟移除，给打印对话框足够时间读取文档
        setTimeout(() => {
          URL.revokeObjectURL(url);
          frame.remove();
        }, 30000);
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const onLoad = () => {
        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
          finish(reject, new Error('无法访问打印文档'));
          return;
        }
        frameWindow.focus();
        frameWindow.print();
        finish(resolve, true);
      };

      // 用户与打印对话框交互后窗口重新获得焦点：视作打印已成功启动
      const onFocus = () => {
        setTimeout(() => finish(resolve, true), 1200);
      };

      // 超时兜底：部分环境 print() 静默失败或 load 不触发
      const fallbackTimer = setTimeout(() => {
        if (settled) return;
        try {
          const frameWindow = frame.contentWindow;
          if (frameWindow) {
            frameWindow.focus();
            frameWindow.print();
            finish(resolve, true);
            return;
          }
        } catch {
          /* noop */
        }
        frame.remove();
        URL.revokeObjectURL(url);
        finish(reject, new Error('系统打印不可用'));
      }, FALLBACK_TIMEOUT_MS);

      frame.addEventListener('load', onLoad);
      window.addEventListener('focus', onFocus);
      frame.src = url;
    }).then(
      () => true,
      () => false
    );
  } catch {
    return false;
  }
}

/**
 * 图片打印回退：逐页渲染为 PNG，放入 #print-root，再调用 window.print()。
 * 打印样式（styles.css @media print）会隐藏页面其余内容并将 #print-root 图片
 * 拉伸为 210mm×297mm 整页输出。afterprint 时清理图片与 blob URL。
 */
async function imagePrint(bytes) {
  const pdf = await openPdf(bytes);
  const root = document.querySelector('#print-root');
  root.textContent = '';
  const images = [];
  const urls = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 }); // pt → px（72pt = 1in）
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      const blobUrl = await canvasToBlobUrl(canvas);
      urls.push(blobUrl);
      const img = document.createElement('img');
      img.src = blobUrl;
      img.alt = `第 ${i} 页（共 ${pdf.numPages} 页）`;
      root.appendChild(img);
      images.push(img);
    }

    // 等待所有图片解码完成，避免打印时出现空白页
    await Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) resolve();
            else {
              img.onload = resolve;
              img.onerror = resolve;
            }
          })
      )
    );

    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      root.textContent = '';
      for (const url of urls) URL.revokeObjectURL(url);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  } catch (error) {
    root.textContent = '';
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  } finally {
    if (pdf.destroy) pdf.destroy();
  }
}

function canvasToBlobUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('图片生成失败'));
    }, 'image/png');
  });
}
