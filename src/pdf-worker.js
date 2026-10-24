/**
 * pdf.js 专用 Worker 入口。
 * pdf.js v5 的 Worker 运行在独立线程，主线程的兼容补丁对其无效，
 * 因此这里先执行补丁（Promise.withResolvers 等），再加载 pdf.js Worker 主体。
 * 由 Vite 以 ES module 形式打包（见 vite.config.js 的 worker.format），
 * 因为 pdf.js 始终以 { type: 'module' } 创建 Worker。
 */
import './modules/polyfills.js';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
