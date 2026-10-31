import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// pdf.js 渲染所需的基础资源（cMap 中文字体映射、标准字体）
// 在构建/预览时从 node_modules 复制到站点根目录的 pdfjs/ 下，运行时通过 BASE_URL 拼接引用
// 注：pdf.js 4.2 无 wasm/iccs 目录（JBIG2 等走 JS 解码），故不再复制
const pdfjsAssets = ['cmaps', 'standard_fonts'];

// 本地联调时 Worker（wrangler dev）端口，与 scripts/dev.mjs 共用同一变量，默认 8787
const apiPort = process.env.MI_API_PORT || '8787';

export default defineConfig({
  // 前端整体位于 app/（index.html、public、src 同迁入），与 worker/ 形成两运行时对称布局
  root: 'app',
  // 相对路径部署：产物不绑定域名根路径，可放在任意子目录/本地静态服务器下打开
  base: './',
  // 构建目标下限：pdf.js 4.2 主包用 top-level await（Chrome 89 / Safari 15 起支持），
  // 故实际下限为 chrome89/edge89/firefox89/safari15；业务源码语法仍受 ESLint 约束为 ES2020。
  build: {
    target: ['chrome89', 'edge89', 'firefox89', 'safari15'],
    // 相对 root（app/）输出到项目根 dist/，与 worker/wrangler.toml 的 [assets] 指向保持一致
    outDir: '../dist',
    // outDir 位于 root 之外时 Vite 默认不清空旧产物，须显式开启以保持每次构建全量替换
    emptyOutDir: true
  },
  // pdf.js 以 { type: 'module' } 创建 Worker，自定义 Worker 入口须同样输出 ES module
  worker: { format: 'es' },
  server: {
    // 本地联调：npm run dev 会同时拉起 wrangler dev(8787)，这里把 /api 代理过去，
    // 从而在 5173 上既有前端热更新，又能使用邮箱导入后端
    proxy: { '/api': `http://127.0.0.1:${apiPort}` }
  },
  plugins: [
    viteStaticCopy({
      targets: [
        ...pdfjsAssets.map((name) => ({
          // 相对 vite root（app/）向上取 node_modules：插件以 config.root 为基准解析 src，
          // 且 stripBase 依赖「相对路径 + ../ 前缀剥离」实现扁平化，勿改成 Windows 绝对路径
          src: `../node_modules/pdfjs-dist/${name}/*`,
          dest: `pdfjs/${name}`,
          // 去掉源目录层级，使文件直接落在 dest 下（而非 dest/node_modules/...）
          rename: { stripBase: true }
        })),
        // 用户文档随构建产物发布，供页面「设置说明 → 查看完整文档」链接访问（产物路径 dist/docs/*.md）
        { src: '../docs/*.md', dest: '.' }
      ]
    })
  ]
});
