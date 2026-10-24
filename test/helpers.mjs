import {
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib';

// 常用页面尺寸（pt），与真实发票常见规格对应
export const A5_LANDSCAPE = [595.28, 419.53]; // A5 横向（约发票小票）
export const A4_PORTRAIT = [595.28, 841.89]; // A4 竖向整页

/**
 * 构造测试用发票 PDF：
 * 每个 spec = { size?, crop?, label?, stamps?, link? }
 * - size   页面 [宽, 高]，默认 A5 横向
 * - crop   可选 CropBox [x, y, w, h]（pdf-lib setCropBox 参数格式）
 * - label  页面主标题文本
 * - stamps 印章/签名外观注解列表，见 addStamp
 * - link   是否附加一个无外观的 Link 注解（验证"无外观注解保留"）
 */
export async function makeInvoicePdf(pageSpecs) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of pageSpecs) {
    const [width, height] = spec.size || A5_LANDSCAPE;
    const page = doc.addPage([width, height]);
    if (spec.crop) page.setCropBox(...spec.crop);

    page.drawText(spec.label || 'INVOICE', {
      x: 40,
      y: height - 80,
      size: 28,
      font,
      color: rgb(0.05, 0.1, 0.25)
    });
    page.drawLine({
      start: { x: 40, y: height - 100 },
      end: { x: width - 40, y: height - 100 },
      thickness: 1,
      color: rgb(0.5, 0.5, 0.5)
    });
    page.drawText('Amount: 100.00', {
      x: 40,
      y: 40,
      size: 14,
      font,
      color: rgb(0.1, 0.1, 0.1)
    });

    for (const stamp of spec.stamps || []) {
      addStamp(doc, page, stamp);
    }

    if (spec.link) {
      // 无外观（无 /AP）的 Link 注解：烘焙逻辑应跳过并保留
      const annotRef = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 140, 34],
          Border: [0, 0, 1]
        })
      );
      page.node.addAnnot(annotRef);
    }
  }

  return doc.save({ useObjectStreams: false });
}

/**
 * 向页面添加一个 Stamp 注解及其外观流（模拟印章/签名）：
 * - flate=true 时用 flateStream 压缩外观内容（模拟真实签名文件）；
 * - withFont 控制外观是否引用 /F1 字体（验证资源改名合并逻辑）；
 * - rect 为注解 Rect（外观 BBox 通过缩放适配 Rect，验证变换计算）。
 */
export function addStamp(doc, page, { rect = [60, 60, 220, 140], flate = true, withFont = true, label = 'SEAL' } = {}) {
  const parts = [];
  if (withFont) {
    parts.push(`BT /F1 22 Tf 0.85 0 0 rg 20 20 Td (${label}) Tj ET`);
  }
  parts.push('2 w 0.85 0 0 rg 4 4 156 56 re S');
  const content = parts.join('\n');

  // 外观流的资源字典：字体 F1 为间接对象（真实签名文件通常如此）
  const resources = {};
  if (withFont) {
    resources.Font = {
      F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }))
    };
  }

  const dict = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 160, 64],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources
  };

  const bytes = new TextEncoder().encode(content);
  const apStream = flate ? doc.context.flateStream(bytes, dict) : doc.context.stream(bytes, dict);
  const apRef = doc.context.register(apStream);
  const annotRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Rect: rect,
      AP: { N: apRef }
    })
  );
  page.node.addAnnot(annotRef);
}

/** 拼接页面所有内容流为字符串（测试断言用）。保存后的 PDF 内容流通常为 Flate 压缩，
 * 统一用 pdf-lib 的 decodePDFRawStream 解码；解码失败时回退原始字节。 */
export function readPageContent(page) {
  const context = page.node.context;
  const rawContents = page.node.get(PDFName.of('Contents'));
  if (rawContents === undefined || rawContents === null) return '';
  const contents = context.lookup(rawContents);
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => context.lookup(ref))
      : [contents];
  return streams
    .map((stream) => {
      if (stream instanceof PDFContentStream) return bytesToString(stream.getUnencodedContents());
      if (stream instanceof PDFRawStream) {
        try {
          return bytesToString(decodePDFRawStream(stream).decode());
        } catch {
          const bytes = stream.getContents();
          return bytes ? bytesToString(bytes) : '';
        }
      }
      return '';
    })
    .join('\n');
}

/** 取页面某类资源字典（Font / XObject 等），不存在返回 null。 */
export function pageResourceDict(page, category) {
  const resources = page.node.normalizedEntries().Resources;
  const raw = resources.get(PDFName.of(category));
  if (raw === undefined || raw === null) return null;
  const value = resources.context.lookup(raw);
  return value instanceof PDFDict ? value : null;
}

/** 读取页面 XObject（如 embedPage 生成的表单 XObject）的内容流文本列表。 */
export function readXObjectContents(page) {
  const dict = pageResourceDict(page, 'XObject');
  if (!dict) return [];
  const context = dict.context;
  const contents = [];
  for (const [, value] of dict.entries()) {
    const stream = context.lookup(value);
    if (stream instanceof PDFRawStream) {
      try {
        contents.push(bytesToString(decodePDFRawStream(stream).decode()));
      } catch {
        const bytes = stream.getContents();
        if (bytes) contents.push(bytesToString(bytes));
      }
    } else if (stream instanceof PDFContentStream) {
      contents.push(bytesToString(stream.getUnencodedContents()));
    }
  }
  return contents;
}

/** 页面某类资源的所有键（如字体名 ['/F1', '/Sig9_F1']）。 */
export function resourceKeys(page, category) {
  const dict = pageResourceDict(page, category);
  if (!dict) return [];
  return dict.keys().map((key) => key.asString());
}

/** 统计文本中匹配正则的数量（自动补 g 标志）。 */
export function countMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (text.match(new RegExp(pattern.source, flags)) || []).length;
}

function bytesToString(bytes) {
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return result;
}
