import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// pdf.js 渲染所需的基础资源（cMap 中文字体映射、标准字体）
// 在构建/预览时从 node_modules 复制到站点根目录的 pdfjs/ 下，运行时通过 BASE_URL 拼接引用
// 注：pdf.js 4.2 无 wasm/iccs 目录（JBIG2 等走 JS 解码），故不再复制
const pdfjsAssets = ['cmaps', 'standard_fonts'];

export default defineConfig({
  // 相对路径部署：产物不绑定域名根路径，可放在任意子目录/本地静态服务器下打开
  base: './',
  // 构建目标下限：pdf.js 4.2 主包用 top-level await（Chrome 89 / Safari 15 起支持），
  // 故实际下限为 chrome89/edge89/firefox89/safari15；业务源码语法仍受 ESLint 约束为 ES2020。
  build: { target: ['chrome89', 'edge89', 'firefox89', 'safari15'] },
  // pdf.js 以 { type: 'module' } 创建 Worker，自定义 Worker 入口须同样输出 ES module
  worker: { format: 'es' },
  plugins: [
    viteStaticCopy({
      targets: pdfjsAssets.map((name) => ({
        src: `node_modules/pdfjs-dist/${name}/*`,
        dest: `pdfjs/${name}`,
        // 去掉源目录层级，使文件直接落在 dest 下（而非 dest/node_modules/...）
        rename: { stripBase: true }
      }))
    })
  ]
});
