import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream
} from 'pdf-lib';

// 需要并入页面资源的注解外观资源类别（ProcSet 为数组且非必需，跳过）
const ANNOT_RESOURCE_CATEGORIES = ['XObject', 'Font', 'ExtGState', 'ColorSpace', 'Shading', 'Pattern'];
const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
// pdf-lib 使用全称 FlateDecode；简称 Fl / Flate 也常见于真实文件
const FLATE_FILTERS = new Set(['FlateDecode', 'Fl', 'Flate']);

/**
 * 将文档中所有带外观流（/AP/N）的注解（数字签名、印章等）“烘焙”进页面内容流，
 * 使外观在嵌入（embedPage）后仍能显示——pdf-lib 的 embedPage 不复制注解。
 *
 * 等价逻辑：
 * 1. 读取注解 /Rect、/AP/N（无状态字典时回退 /AP/D；状态字典不处理）；
 * 2. 计算外观流 BBox/Matrix 到 Rect 的仿射变换（含 Rect/BBox 尺寸缩放）；
 * 3. 外观内容外包一层 q … cm … Q 追加到页面 Contents 末尾（显示在页面内容之上）；
 * 4. 外观引用的资源（/F1 等）以 Sig{外观对象号}_{原名} 为键并入页面 Resources，
 *    内容流中的引用同步替换（按键名长度降序替换，避免 /F1 误伤 /F10）；
 * 5. 烘焙成功的注解从 /Annots 中移除（保留无外观或不支持编码的注解）。
 *
 * @param {PDFDocument} doc 已加载的 pdf-lib 文档（原地修改）
 * @returns {Promise<number>} 烘焙的注解数量
 */
export async function flattenDocument(doc) {
  const context = doc.context;
  let flattenedCount = 0;

  for (const page of doc.getPages()) {
    // Annots() 在缺失时抛错，捕获后跳过该页
    let annotsArray = null;
    try {
      annotsArray = page.node.Annots();
    } catch {
      continue;
    }
    if (!(annotsArray instanceof PDFArray)) continue;

    const bakedContents = [];
    const merges = [];

    // 倒序遍历以便安全地按索引删除
    for (let i = annotsArray.size() - 1; i >= 0; i--) {
      const annotRef = annotsArray.get(i);
      const annot = context.lookup(annotRef);
      if (!(annot instanceof PDFDict)) continue;

      const rect = readRect(lookupArrayMaybe(context, annot, 'Rect'));
      if (!rect) continue;

      const appearance = resolveAppearance(annot);
      if (!appearance) continue;

      const baked = bakeAppearance(context, appearance.stream, appearance.ref, rect);
      if (!baked) continue;

      annotsArray.remove(i);
      bakedContents.push(baked.content);
      for (const merge of baked.merges) merges.push(merge);
      flattenedCount++;
    }

    if (bakedContents.length === 0) continue;

    // 将外观资源并入页面 Resources（原键保留，仅新增带 Sig 前缀的键）
    if (merges.length > 0) {
      const resources = page.node.normalizedEntries().Resources;
      applyResourceMerges(context, resources, merges);
    }

    // 后烘焙的注解先绘制（视觉上更靠上）；数组本身倒序收集，这里 reverse 恢复原始顺序
    const contentBytes = new TextEncoder().encode(`${bakedContents.reverse().join('\n')}\n`);
    // context.stream 生成无 Filter 的原始流，保存时不压缩
    const streamRef = context.register(context.stream(contentBytes));
    appendPageContent(page, context, streamRef);
  }

  return flattenedCount;
}

/**
 * 解析注解的外观流：/AP/N 直接是流则用之；否则尝试 /AP/D/N（当前值状态字典）。
 * 返回流对象及其 PDFRef（用于外观对象号命名 Sig{objNum}_*）；N 为状态字典时放弃烘焙。
 */
function resolveAppearance(annot) {
  const context = annot.context;
  const apDict = lookupDictMaybe(context, annot, 'AP');
  if (!apDict) return null;

  const nRaw = apDict.get(PDFName.of('N'));
  const nValue = nRaw === undefined ? undefined : context.lookup(nRaw);
  if (nValue instanceof PDFStream) {
    return { stream: nValue, ref: nRaw instanceof PDFRef ? nRaw : null };
  }

  const dDict = lookupDictMaybe(context, apDict, 'D');
  if (dDict) {
    const dnRaw = dDict.get(PDFName.of('N'));
    const dnValue = dnRaw === undefined ? undefined : context.lookup(dnRaw);
    if (dnValue instanceof PDFStream) {
      return { stream: dnValue, ref: dnRaw instanceof PDFRef ? dnRaw : null };
    }
  }

  return null;
}

/**
 * 计算外观到页面的仿射变换并生成烘焙内容。
 *
 * 变换公式：
 *   sx = Rect宽 / BBox宽（BBox 宽为 0 时取 1），sy 同理；
 *   CTM = [sx*a, sy*b, sx*c, sy*d, Rect.x1+(e-BBox.x1)*sx, Rect.y1+(f-BBox.y1)*sy]
 * 其中 [a,b,c,d,e,f] 为外观流 /Matrix（缺省单位矩阵）。
 * 仅支持无过滤器或 FlateDecode 的外观；其他编码返回 null 保留注解。
 */
function bakeAppearance(context, stream, apRef, rect) {
  const filters = readFilters(context, stream.dict);
  if (filters.length > 0 && !filters.every((filter) => FLATE_FILTERS.has(filter))) return null;

  const bbox = readRect(lookupArrayMaybe(context, stream.dict, 'BBox'));
  if (!bbox) return null;
  const matrix = readMatrix(lookupArrayMaybe(context, stream.dict, 'Matrix')) || IDENTITY_MATRIX;

  const appearanceContent = decodeStreamBytes(stream, filters);
  if (appearanceContent === null) return null;

  const { sx, sy } = computeScale(rect, bbox);
  const ctm = [
    sx * matrix.a,
    sy * matrix.b,
    sx * matrix.c,
    sy * matrix.d,
    rect.x1 + (matrix.e - bbox.x1) * sx,
    rect.y1 + (matrix.f - bbox.y1) * sy
  ];

  let content = `q\n${ctm.map(formatNumber).join(' ')} cm\n${appearanceContent}\nQ`;

  // 外观资源改名并入页面资源；内容流中的旧键引用同步替换
  const apResources = lookupDictMaybe(context, stream.dict, 'Resources');
  const merges = apRef ? collectResourceMerges(context, apResources, apRef) : [];
  // 长键优先替换，防止 /F1 把 /F10 截断改坏
  merges.sort((a, b) => b.oldKey.length - a.oldKey.length);
  for (const merge of merges) {
    content = replaceKey(content, merge.oldKey, merge.newKey);
  }

  return { content, merges };
}

/**
 * 解码外观流字节：无过滤器时直接取原始内容；FlateDecode 等使用 pdf-lib 内置的
 * decodePDFRawStream（内部为 pako 实现，浏览器/Node 通用）。失败返回 null。
 */
function decodeStreamBytes(stream, filters) {
  try {
    if (filters.length === 0) {
      if (stream instanceof PDFRawStream) {
        const contents = stream.getContents();
        return contents ? bytesToString(contents) : '';
      }
      return null;
    }
    return bytesToString(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
}

/** 读取 /Filter（可能是单个名称或名称数组），统一返回字符串数组；异常返回空数组。 */
function readFilters(context, dict) {
  const filters = [];
  const rawFilter = dict.get(PDFName.of('Filter'));
  if (rawFilter === undefined) return filters;
  let value;
  try {
    value = context.lookup(rawFilter);
  } catch {
    return filters;
  }
  const items = value instanceof PDFArray ? value.asArray().map((ref) => context.lookup(ref)) : [value];
  for (const item of items) {
    filters.push(item instanceof PDFName ? item.asString().replace(/^\//, '') : '');
  }
  return filters;
}

/**
 * 收集外观 Resources 中各类资源的改名映射：
 * 新键名 = Sig{外观流对象号}_{原键名}，值为原始 PDFRef（随后并入页面资源字典）。
 * 仅处理间接引用（PDFRef）；外观对象缺失时返回空数组（不改名，直接烘焙——内容中引用不变）。
 */
function collectResourceMerges(context, apResources, apRef) {
  const merges = [];
  if (!(apResources instanceof PDFDict)) return merges;

  for (const category of ANNOT_RESOURCE_CATEGORIES) {
    const categoryKey = PDFName.of(category);
    const rawCategory = apResources.get(categoryKey);
    const apCategory = rawCategory === undefined ? undefined : context.lookup(rawCategory);
    if (!(apCategory instanceof PDFDict)) continue;

    for (const [key, value] of apCategory.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const baseName = key.asString().replace(/^\//, '');
      merges.push({
        category,
        oldKey: key.asString(),
        newKey: PDFName.of(`Sig${apRef.objectNumber}_${baseName}`),
        value
      });
    }
  }
  return merges;
}

/**
 * 将外观资源以新键写入页面 Resources。对应类别字典不存在时创建空字典；
 * 已存在但类型异常时不覆盖（跳过该类别，宁可丢资源也不破坏页面）。
 */
function applyResourceMerges(context, pageResources, merges) {
  const grouped = new Map();
  for (const merge of merges) {
    if (!grouped.has(merge.category)) grouped.set(merge.category, []);
    grouped.get(merge.category).push(merge);
  }

  for (const [category, list] of grouped) {
    const categoryKey = PDFName.of(category);
    const raw = pageResources.get(categoryKey);
    let target;
    if (raw === undefined) {
      target = context.obj({});
      pageResources.set(categoryKey, target);
    } else {
      try {
        target = context.lookupMaybe(raw, PDFDict);
      } catch {
        target = null;
      }
      if (!target) continue;
    }
    for (const merge of list) {
      target.set(merge.newKey, merge.value);
    }
  }
}

/** 将烘焙内容流追加到页面 /Contents（兼容单流、流数组两种既有形态）。 */
function appendPageContent(page, context, streamRef) {
  const rawContents = page.node.get(PDFName.of('Contents'));
  if (rawContents instanceof PDFRef) {
    const existing = context.lookup(rawContents);
    if (existing instanceof PDFArray) {
      existing.push(streamRef);
      return;
    }
    const contentsArray = context.obj([rawContents]);
    contentsArray.push(streamRef);
    page.node.set(PDFName.of('Contents'), contentsArray);
    return;
  }
  if (rawContents !== undefined && rawContents !== null) {
    const existing = context.lookup(rawContents);
    if (existing instanceof PDFArray) {
      existing.push(streamRef);
      return;
    }
    const contentsArray = context.obj([rawContents]);
    contentsArray.push(streamRef);
    page.node.set(PDFName.of('Contents'), contentsArray);
    return;
  }
  page.node.set(PDFName.of('Contents'), context.obj([streamRef]));
}

/** 二进制字符串内替换 PDF 名称键（外观内容为 ASCII 操作符流，直接字符串替换安全）。 */
function replaceKey(content, oldKey, newKey) {
  const plainNewKey = newKey.asString();
  const positions = [];
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf(oldKey, from);
    if (at < 0) break;
    positions.push(at);
    from = at + oldKey.length;
  }
  if (positions.length === 0) return content;

  const parts = [];
  let cursor = 0;
  for (const at of positions) {
    parts.push(content.slice(cursor, at));
    parts.push(plainNewKey);
    cursor = at + oldKey.length;
  }
  parts.push(content.slice(cursor));
  return parts.join('');
}

// —— 低层读取辅助：lookup 链路统一捕获类型异常，返回 null/undefined ——

function lookupArrayMaybe(context, dict, name) {
  const raw = dict.get(PDFName.of(name));
  if (raw === undefined || raw === null) return null;
  try {
    const value = context.lookup(raw);
    return value instanceof PDFArray ? value : null;
  } catch {
    return null;
  }
}

function lookupDictMaybe(context, dict, name) {
  const raw = dict.get(PDFName.of(name));
  if (raw === undefined || raw === null) return null;
  try {
    const value = context.lookup(raw);
    return value instanceof PDFDict ? value : null;
  } catch {
    return null;
  }
}

/** Rect 尺寸 / BBox 尺寸的缩放系数；BBox 该维为 0 时退化为 1。 */
function computeScale(rect, bbox) {
  const bboxWidth = bbox.x2 - bbox.x1;
  const bboxHeight = bbox.y2 - bbox.y1;
  const sx = bboxWidth > 0 ? (rect.x2 - rect.x1) / bboxWidth : 1;
  const sy = bboxHeight > 0 ? (rect.y2 - rect.y1) / bboxHeight : 1;
  return { sx, sy };
}

/** 解析 4 元素矩形数组并规范化（交换使 x1<=x2、y1<=y2）。 */
function readRect(array) {
  if (!(array instanceof PDFArray) || array.size() !== 4) return null;
  const numbers = [];
  for (let i = 0; i < 4; i++) {
    const value = array.lookup(i);
    const num = typeof value.asNumber === 'function' ? value.asNumber() : Number.NaN;
    if (Number.isNaN(num)) return null;
    numbers.push(num);
  }
  let [x1, y1, x2, y2] = numbers;
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  return { x1, y1, x2, y2 };
}

/** 解析 6 元素变换矩阵数组。 */
function readMatrix(array) {
  if (!(array instanceof PDFArray) || array.size() !== 6) return null;
  const numbers = [];
  for (let i = 0; i < 6; i++) {
    const value = array.lookup(i);
    const num = typeof value.asNumber === 'function' ? value.asNumber() : Number.NaN;
    if (Number.isNaN(num)) return null;
    numbers.push(num);
  }
  return { a: numbers[0], b: numbers[1], c: numbers[2], d: numbers[3], e: numbers[4], f: numbers[5] };
}

/** 数值格式化：保留 6 位小数并去掉尾随 0，-0 归一为 0。 */
function formatNumber(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Uint8Array → 二进制字符串（分块避免超长参数展开）。 */
function bytesToString(bytes) {
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return result;
}
