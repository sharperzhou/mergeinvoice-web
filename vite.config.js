import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// pdf.js 渲染所需的基础资源（cMap 中文字体映射、标准字体、wasm、icc 色彩配置）
// 在构建/预览时从 node_modules 复制到站点根目录的 pdfjs/ 下，运行时通过 BASE_URL 拼接引用
const pdfjsAssets = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

export default defineConfig({
  // 相对路径部署：产物不绑定域名根路径，可放在任意子目录/本地静态服务器下打开
  base: './',
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
