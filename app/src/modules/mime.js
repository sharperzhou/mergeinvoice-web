// RFC822 / MIME 邮件解析（仅提取 PDF/ZIP 附件，供邮箱导入前端使用）：
// 整封邮件按 latin1 字符串处理做结构解析（边界/头均为 ASCII 字节，latin1 往返无损），
// 附件内容再按 CTE（base64 / quoted-printable / 8bit）还原为字节。

/** 解出邮件中的 PDF/ZIP 附件 → [{ filename, bytes }]（坏部件静默跳过，不抛错）。 */
export function extractAttachments(message) {
  const text = typeof message === 'string' ? message : bytesToLatin1(message);
  const [head, body] = splitHeadBody(text);
  const out = [];
  walkEntity(parseHeaders(head), body, out, { depth: 0, n: 0 });
  return out;
}

/**
 * 解析邮件头部块（search 结果用）→ { subject, from, date }。
 * 返回未解码的原始值，中文主题/发件人用 decodeMimeWords 进一步解码。
 */
export function parseMessageHeaders(raw) {
  const text = typeof raw === 'string' ? raw : bytesToLatin1(raw);
  const [head] = splitHeadBody(text);
  const map = parseHeaders(head);
  return { subject: map.subject || '', from: map.from || '', date: map.date || '' };
}

/**
 * 解码 RFC2047 编码词（=?charset?B?…?= / =?charset?Q?…?=，含相邻编码词间空白忽略规则）。
 * 非编码文本原样保留；未知字符集回退 UTF-8 再回退 latin1。
 */
export function decodeMimeWords(text) {
  if (!text || text.indexOf('=?') < 0) return text;
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let lastEnd = 0;
  let prevWasWord = false;
  let m = re.exec(text);
  while (m !== null) {
    const between = text.slice(lastEnd, m.index);
    // RFC2047：相邻编码词之间的空白（含折行空格）不作为内容输出
    const adjacent = prevWasWord && between.replace(/[\s]/g, '') === '';
    out += (adjacent ? '' : between) + decodeWord(m[1], m[2], m[3]);
    lastEnd = m.index + m[0].length;
    prevWasWord = true;
    m = re.exec(text);
  }
  return out + text.slice(lastEnd);
}

// —— 内部实现 ——

/** 按 CRLFCRLF / LFLF 切分头部与正文。 */
function splitHeadBody(text) {
  let idx = text.indexOf('\r\n\r\n');
  let sep = 4;
  if (idx < 0) {
    idx = text.indexOf('\n\n');
    sep = 2;
  }
  if (idx < 0) return [text, ''];
  return [text.slice(0, idx), text.slice(idx + sep)];
}

/** 解析头部块：折行展开（续行以空白开头），键小写、首见优先。 */
function parseHeaders(block) {
  const map = {};
  const lines = block.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (current !== null && (line.startsWith(' ') || line.startsWith('\t'))) {
      map[current] += ' ' + line.trim(); // 折行续接
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = line.slice(colon + 1).trim();
    current = key;
  }
  return map;
}

/**
 * 递归遍历实体：multipart 按 boundary 拆子件继续下钻，
 * 叶子件命中 PDF/ZIP（按扩展名或 Content-Type）则解码收入 out。
 */
function walkEntity(headers, body, out, ctx) {
  if (ctx.depth > 10) return; // 防御异常深层嵌套
  const ct = parseHeaderValue(headers['content-type'] || '');
  const type = ct ? ct.value.toLowerCase() : 'text/plain';

  if (type.startsWith('multipart/') && ct.params.boundary) {
    const parts = splitMultipart(body, ct.params.boundary);
    for (const part of parts) {
      const [pHead, pBody] = splitHeadBody(part);
      walkEntity(parseHeaders(pHead), pBody, out, { depth: ctx.depth + 1, n: ctx });
    }
    return;
  }

  const cd = parseHeaderValue(headers['content-disposition'] || '');
  const filename = pickFilename(cd ? cd.params : {}, ct ? ct.params : {});
  const isPdfType = type === 'application/pdf';
  const isZipType = type === 'application/zip' || type === 'application/x-zip-compressed';
  const ext = filename ? fileExt(filename) : null;

  // 收录条件：文件名扩展为 pdf/zip；或无文件名但类型即 PDF/ZIP（裸附件邮件）
  let include = ext === 'pdf' || ext === 'zip';
  if (!filename && (isPdfType || isZipType)) include = true;
  if (!include) return;

  const name = filename || `附件-${ctx.n + 1}.${isZipType ? 'zip' : 'pdf'}`;
  ctx.n += 1;
  const bytes = decodeBody(body, headers['content-transfer-encoding'] || '7bit');
  if (bytes.length > 0) out.push({ filename: name, bytes });
}

/** 按 Content-Transfer-编码还原字节：坏 base64 静默跳过（该附件不收录）。 */
function decodeBody(body, cte) {
  const enc = cte.trim().toLowerCase();
  try {
    if (enc === 'base64') return base64ToBytes(body);
    if (enc === 'quoted-printable') return latin1ToBytes(qpToString(body));
    return latin1ToBytes(body); // 7bit / 8bit / binary：latin1 往返无损
  } catch {
    return new Uint8Array(0);
  }
}

/** 拆 multipart 正文为子件文本数组（丢弃定界行与其前置 CRLF）。 */
function splitMultipart(body, boundary) {
  const delimiter = `--${boundary}`;
  const parts = [];
  let idx = body.indexOf(delimiter);
  while (idx !== -1) {
    const after = idx + delimiter.length;
    if (body.slice(after, after + 2) === '--') break; // --boundary-- 终止符
    let lineEnd = after;
    if (body.slice(after, after + 2) === '\r\n') lineEnd = after + 2;
    else if (body.slice(after, after + 1) === '\n') lineEnd = after + 1;
    const next = body.indexOf(delimiter, lineEnd);
    let partEnd = next === -1 ? body.length : next;
    if (next !== -1) {
      // 定界行前的 CRLF 属于定界行而非数据
      if (body.slice(partEnd - 2, partEnd) === '\r\n') partEnd -= 2;
      else if (body.slice(partEnd - 1, partEnd) === '\n') partEnd -= 1;
    }
    parts.push(body.slice(lineEnd, partEnd));
    idx = next;
  }
  return parts;
}

/**
 * 解析「主值; k=v; k2="v2"」式头部 → { value, params }（键小写、首见优先，
 * 带引号值可含分号）。空头部返回 null。
 */
function parseHeaderValue(rawValue) {
  if (!rawValue) return null;
  const params = {};
  const re = /;\s*([^=;\s"]+)\s*=\s*("([^"]*)"|[^;]*)/g;
  const first = re.exec(rawValue);
  const main = first ? rawValue.slice(0, first.index) : rawValue;
  let m = first;
  while (m !== null) {
    const key = m[1].toLowerCase();
    const value = (m[3] !== undefined ? m[3] : m[2]).trim();
    if (!Object.prototype.hasOwnProperty.call(params, key)) params[key] = value;
    m = re.exec(rawValue);
  }
  return { value: main.trim(), params };
}

/**
 * 提取文件名：优先 RFC2231 filename*（charset'lang'百分号编码）> filename >
 * Content-Type 的 name* / name；再解 RFC2047 编码词（不规范发件人常见），最后取路径末段。
 */
function pickFilename(cdParams, ctParams) {
  let raw;
  let star = false;
  if (cdParams['filename*'] !== undefined) {
    raw = cdParams['filename*'];
    star = true;
  } else if (cdParams.filename !== undefined) {
    raw = cdParams.filename;
  } else if (ctParams['name*'] !== undefined) {
    raw = ctParams['name*'];
    star = true;
  } else if (ctParams.name !== undefined) {
    raw = ctParams.name;
  } else {
    return null;
  }

  if (star) {
    // 形如 charset'language'percent-encoded
    const m = /^([^']*)'[^']*'(.*)$/.exec(raw);
    if (m) {
      raw = textFromBytes(percentToBytes(m[2]), m[1] || 'utf-8');
    }
  } else {
    raw = decodeMimeWords(raw);
  }

  raw = raw.replace(/[\r\n]/g, '').trim();
  if (!raw) return null;
  const segments = raw.split(/[\\/]/); // 去掉 C:\fakepath 与路径目录
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return null;
}

/** RFC2231 百分号编码 → 原始字节（非转义字符按 ASCII 取低 8 位，非法 %xx 保留原字符）。 */
function percentToBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** 取文件扩展名（小写；无点或无扩展返回 null）。 */
function fileExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** 解码单个 RFC2047 编码词（B=base64，Q=可打印，Q 的下划线视为空格）。 */
function decodeWord(charset, kind, payload) {
  try {
    let bytes;
    if (kind.toUpperCase() === 'B') {
      bytes = base64ToBytes(payload);
    } else {
      bytes = latin1ToBytes(qpToString(payload.replace(/_/g, ' ')));
    }
    return textFromBytes(bytes, charset);
  } catch {
    return payload; // 解不动就原样返回，不让头部显示崩掉
  }
}

/** 按字符集字节解码为文本（未知字符集回退 UTF-8，再回退逐字节 latin1）。 */
function textFromBytes(bytes, charset) {
  const label = (charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return bytesToLatin1(bytes);
    }
  }
}

/** quoted-printable 解码为 latin1 文本（软换行与 =XX 转义）。 */
function qpToString(input) {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '=') {
      out += ch;
      continue;
    }
    const hex = input.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (input.slice(i + 1, i + 3) === '\r\n') {
      i += 2; // 软换行
      continue;
    }
    if (input[i + 1] === '\n') {
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** base64 → 字节（去空白、补 padding；非法输入抛错交由调用方跳过）。 */
function base64ToBytes(input) {
  const clean = input.replace(/[\s\r\n]+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  const padded = clean.length % 4 === 0 ? clean : clean + '='.repeat(4 - (clean.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 字节 → latin1 字符串（分块避免大附件撑爆 apply 栈）。 */
function bytesToLatin1(bytes) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** latin1 字符串 → 字节（逐字符低 8 位，往返无损）。 */
function latin1ToBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
