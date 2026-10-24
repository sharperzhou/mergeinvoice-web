# AGENTS.md — Agent 工作指南

## 项目简介

MergeInvoice-web：**纯前端**（无后端）发票拼版工具。浏览器本地导入 PDF 发票，将两张 A5 版式发票拼版到单张 A4（第二张旋转 180°、中线附裁切标记），A4 整页逐张输出；支持预览、按页删除、拖拽排序、下载与系统打印。文件数据不出本机，构建产物可整体静态部署。

## 常用命令（win32 / PowerShell，npm 必须用 `npm.cmd`）

```powershell
npm.cmd run dev      # 开发服务器
npm.cmd run build    # 构建到 dist/（含 pdfjs 运行时资源复制）
npm.cmd test         # node --test，当前 18 个测试
npm.cmd run preview  # 预览构建产物
```

**改动后的必跑验证**：`npm.cmd test`（18 pass）+ `npm.cmd run build`。项目无 lint/typecheck。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `index.html` | 向导三步骤（导入 → 合并 → 下载/打印）、步骤条、弹窗、页脚（引用 `%BASE_URL%favicon.svg`） |
| `public/favicon.svg` | 站点图标（SVG，Vite 原样复制到 dist 根目录） |
| `src/main.js` | 全部 UI 状态与交互：导入/去重/页数上限、页管理（删页）、步骤切换、结果页删除与拖拽排序、拖拽自动滚动、resize 重渲染 |
| `src/styles.css` | 样式（容器 `min(1600px, 100% - 40px)` 自适应；预览框 aspect-ratio） |
| `src/modules/invoices.js` | 记录创建、页分类、`countKinds`/`isMergeable`、内容哈希去重、`MAX_IMPORT_PAGES=10` 与 `probePageCount` |
| `src/modules/merge.js` | 合并规则（A5 两拼 / A4 整页 / 裁切标记）；`isPageIncluded` 排除已删页 |
| `src/modules/flatten.js` | 注解外观（印章/签名）扁平化烘焙进内容流 |
| `src/modules/preview.js` | pdf.js 打开与渲染（`renderInto` 按实测宽高适配） |
| `src/modules/print.js` | 打印（原生 iframe 优先，失败退图片模式） |
| `test/` | `node --test`；`helpers.mjs` 造发票/印章夹具与断言工具 |

## 业务规则（勿擅自改动）

- 分类阈值：有效宽 > 615pt → 跳过；有效高 < 841.889/2（≈420.9445pt）→ A5，否则 A4。有效盒 = MediaBox ∩ CropBox。
- A5 两两拼 A4：上半顶对齐水平居中，下半 `rotate: 180°` 锚点 `(x=居中+页宽, y=页高)`；中线画 10pt/1pt 裁切线（x 10→20、W−10→W−20）；奇数页单独成页仍画中线。
- A4 整页：`h + 50 < 页高` 才画底部裁切线。输出顺序：A5 在前、A4 在后，均保持导入顺序。
- 输出：`合并发票yyyyMMddHHmmss.pdf`；保存参数 `{ useObjectStreams: false }`。
- 导入限制：单 PDF > `MAX_IMPORT_PAGES`（10）页拒绝导入（`probePageCount` 结构级快查，拒绝前不做扁平化/渲染）。
- `vite.config.js`：`base: './'`（相对路径部署）；pdfjs 运行时资源复制必须保留 `rename: { stripBase: true }`。

## 关键注意事项（踩过的坑）

- **pdf-lib**：`PDFObject` 没有 `.ref`；字符串经 `context.obj()` 会变 `PDFName`（不带前导斜杠）；typed `lookup` 类型不符会抛错（用 try/catch 包住）；`page.node.MediaBox()` 缺失时抛错；`PDFArray` 有 `get/insert/remove`。
- **重排/删页**：`/Kids` 在 `/Pages` 节点上（`catalog.lookup(PDFName.of('Pages'))`），**不在**文档目录上；数组元素为页面引用，改动后 `save` 生效。`removePage`/`getPageCount` 可直接用。
- **已保存 PDF 的内容流是 Flate 压缩的**：测试断言读页面内容须用 `decodePDFRawStream(stream).decode()`（夹具 `helpers.mjs` 已封装）；印章/签名文本在嵌入页 XObject 内，用 `readXObjectContents(page)`。
- **pdf.js v5**：worker 用 `?url` 导入设置 `workerSrc`（不用 `workerPort`）；`render` 传 `transform`（dpr 放大）；同一 canvas 连续渲染先 abort 旧任务。
- **注释一律用中文**（项目约定，源码与测试都要有注释）。
- **文件编码统一 UTF-8（无 BOM）**：中文 Windows 环境默认编码为 GBK/GB2312，用系统默认编码写文件会导致中文注释/文档乱码。
  - 所有源码、测试、Markdown、HTML、JSON/配置文件必须保存为 **UTF-8 无 BOM**；新增 HTML 文件须声明 `<meta charset="UTF-8">`；
  - 禁止依赖默认编码读写文件：PowerShell 中 `>`、`Out-File`、`Set-Content` 不带 `-Encoding` 时按版本输出 UTF-16LE 或 ANSI(GBK)，写文件必须显式 `-Encoding utf8`（或改用会自动输出 UTF-8 的工具）；
  - 读取含中文的文件做校验时显式指定 UTF-8（如 `Get-Content -Encoding utf8`），避免按 GBK 解码得到乱码后误判文件损坏；
  - **换行统一 CRLF**：本项目在 Windows 下开发（工作区文件为 CRLF），依赖 `core.autocrlf=true` 在提交时自动转换为 LF 入库；自动部署至 Linux 后检出即为 LF。不需要 `.gitattributes`，也不要强制把工作区改成 LF，避免同仓库换行风格混用产生 diff 噪声。
- 文件名可能含 HTML 特殊字符，写入 DOM 必须用 `textContent`。
- **Markdown 文档中禁止使用 ASCII 字符画**（`┌─┐│` 等框线字符在不同查看器/字体下宽度不一致，CJK 混排必然错位）：示意图改用 SVG/PNG 图片（存放于 `assets/`，如 `assets/merge-layout.svg`），或用纯文字/表格描述。目录树例外：代码块内「框线 + ASCII 路径、CJK 仅出现在尾部注释」的树形列表可以保留。

## Git

分支 `main`；`.gitignore` 忽略 `node_modules/`、`dist/`，不提交依赖与构建产物。**未经用户明确要求不要 commit/push**。

### 提交消息规范（Conventional Commits，摘要用中文）

```
<type>(<scope>): <摘要，中文，≤50字，不加句号>

<可选正文：以 - 列出关键要点>
```

- `type`：`feat`（新功能/行为变化）、`fix`（缺陷修复）、`docs`（仅文档）、`refactor`（无行为变化重构）、`test`（测试增改）、`chore`（构建/依赖/杂项）、`style`（格式/注释）
- `scope` 可选：`merge` / `flatten` / `ui` / `preview` / `import` 等模块名
- 摘要精确描述"做了什么"，不写"更新/修改"等模糊词；一次提交只表达一个主题
- 提交消息文件须为 UTF-8（用 `git commit -F` 传入文件可避免命令行转码问题）
