// 最小 IMAP4rev1 客户端（仅实现本项目所需命令）：
// LOGIN / ID（网易系要求的客户端身份声明）/ SELECT / UID SEARCH SINCE…BEFORE /
// UID FETCH（邮件头 + BODYSTRUCTURE，正文 BODY[]）/ LOGOUT。
// 构造入参为 { readable, writable }（cloudflare:sockets 的 Socket 同形状），
// index.js 里才调用 connect()——测试可用内存假服务器注入对应流。
// 行读取支持 CRLF 与裸 LF；带字面量（{n}）的 FETCH 响应按「行 → n 字节 → 行」消费。

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const encoder = new TextEncoder();

/** IMAP 日期格式 dd-Mmm-yyyy（UTC，如 01-Oct-2026）。 */
export function formatImapDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** IMAP 协议/网络错误：status 区分 AUTH（登录被拒）/ NO / BAD / TIMEOUT / CLOSED 等。 */
export class ImapError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ImapError';
    this.status = status || 'ERROR';
    this.detail = detail || '';
  }
}

/** IMAP 字符串参数双引号包裹（转义内部 " 与 \）。 */
function quoteArg(value) {
  return `"${String(value).replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * 计算文本段中的括号差值：引号串内的括号不参与配对（BODYSTRUCTURE 的文件名等参数
 * 可能含括号），反斜杠转义跳过下一个字符。
 */
function parenBalance(text) {
  let balance = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 92) i += 1;
      else if (ch === 34) inString = false;
      continue;
    }
    if (ch === 34) inString = true;
    else if (ch === 40) balance += 1;
    else if (ch === 41) balance -= 1;
  }
  return balance;
}

/** 去掉字节数组列表末段可能残留的 CR（CRLF 被切在两块时）。 */
function trimTrailingCR(parts) {
  const last = parts.length > 0 ? parts[parts.length - 1] : null;
  if (last && last.length > 0 && last[last.length - 1] === 13) {
    parts[parts.length - 1] = last.subarray(0, last.length - 1);
  }
}

/** 多段字节拼接后按 UTF-8 解码为行文本（响应行均为 ASCII）。 */
function decodeParts(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return new TextDecoder().decode(parts[0]);
  let total = 0;
  for (const part of parts) total += part.length;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buf.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(buf);
}

/** 邮件头字节 → 文本：严格 UTF-8 失败回退 GBK（国内邮箱偶发 8bit 头），再退回宽松 UTF-8。 */
function headerBytesToString(bytes) {
  if (!bytes || bytes.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* 落到 GBK 回退 */
  }
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * 字节流读取器：readLine（行，不含行尾符）/ readBytes（精确 n 字节）。
 * 跨 chunk 的 CRLF、行内字面量切换（{n} 后直接接原始字节）均已处理。
 */
class LineReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.rest = null; // 已读但未消费的剩余字节
    this.eof = false;
  }

  /** 取下一段可用字节（优先剩余缓存），耗尽返回 null。 */
  async _pull() {
    if (this.rest && this.rest.length > 0) {
      const chunk = this.rest;
      this.rest = null;
      return chunk;
    }
    if (this.eof) return null;
    const { done, value } = await this.reader.read();
    if (done) {
      this.eof = true;
      return null;
    }
    if (!value || value.length === 0) return this._pull(); // 跳过空块
    return value;
  }

  /** 读一行（以 LF 结尾，兼容前置 CR 与裸 LF）；连接关闭抛 CLOSED。 */
  async readLine() {
    const parts = [];
    let prevCR = false; // 上一消费字节是否为 CR（LF 恰在 chunk 首位时判定用）
    for (;;) {
      const chunk = await this._pull();
      if (!chunk) throw new ImapError('IMAP 连接已关闭', 'CLOSED');
      let cut = -1;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) {
          cut = i;
          break;
        }
        prevCR = chunk[i] === 13;
      }
      if (cut >= 0) {
        let end = cut;
        if (end > 0 && chunk[end - 1] === 13) end -= 1; // 行尾 CRLF：去掉 CR
        else if (end === 0 && prevCR) trimTrailingCR(parts); // CR 在上一 chunk 尾
        if (end > 0) parts.push(chunk.subarray(0, end));
        if (cut + 1 < chunk.length) this.rest = chunk.subarray(cut + 1);
        return decodeParts(parts);
      }
      parts.push(chunk);
    }
  }

  /** 精确读取 n 字节（字面量内容，可为任意二进制）。 */
  async readBytes(n) {
    if (n <= 0) return new Uint8Array(0);
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = await this._pull();
      if (!chunk) throw new ImapError('IMAP 连接已关闭（读取字面量中断）', 'CLOSED');
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (chunk.length > take) this.rest = chunk.subarray(take);
    }
    return out;
  }
}

/** 从 FETCH 响应的字面量中挑出邮件头（BODYSTRUCTURE 理论上也可能以字面量返回，按「像邮件头」区分）。 */
function pickHeaderLiteral(literals) {
  if (literals.length <= 1) return literals[0];
  for (const bytes of literals) {
    const head = new TextDecoder().decode(bytes.subarray(0, 512));
    if (/^[A-Za-z-]+:/m.test(head)) return bytes;
  }
  return literals[0];
}

/** 从 FETCH 响应文本中截取 BODYSTRUCTURE 的括号结构（跳过引号串，串内的括号/转义不参与配对）。 */
function extractStructure(text) {
  const m = /\bBODYSTRUCTURE\b/i.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '(') return null;
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (ch === '\\') j += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** 从 BODYSTRUCTURE 提取名称参数候选值（NAME / FILENAME，含 RFC2231 的 `*` 变体），供前端关键词匹配附件名。 */
function extractAttachmentNames(structure) {
  if (!structure) return [];
  const names = [];
  const re = /"(?:NAME|FILENAME)\*?"\s+"((?:[^"\\]|\\.)*)"/gi;
  let m;
  while ((m = re.exec(structure)) !== null) {
    const value = m[1].replace(/\\(.)/g, '$1');
    if (value) names.push(value);
  }
  return names;
}

/**
 * 服务端附件预判：BODYSTRUCTURE 是否可能有 PDF/ZIP 附件（与前端 structureHasAttachment 同规则）。
 * 原则：宁可多取，绝不漏掉真实发票（含 application/* 部件、.pdf/.zip 名称参数、
 * 结构缺失或含字面量占位 `{n}`）。
 */
export function structureLooksLikeAttachment(structure) {
  if (!structure) return true;
  const upper = structure.toUpperCase();
  if (upper.indexOf('{') >= 0) return true;
  if (/"APPLICATION"/.test(upper)) return true;
  return /"[^"]*\.(PDF|ZIP)[^"]*"/.test(upper);
}

/** IMAP 会话：顺序执行命令直到标记行（tagged completion）。 */
export class ImapSession {
  constructor({ readable, writable }) {
    this.reader = new LineReader(readable);
    this.writer = writable.getWriter();
    this.tagSeq = 0;
  }

  /** 读取连接问候行（* OK / * PREAUTH / * BYE）。 */
  async readGreeting() {
    const line = await this.reader.readLine();
    if (/^\*\s+BYE/i.test(line)) throw new ImapError('IMAP 服务器拒绝连接', 'BAD', line);
    if (!/^\*\s+(OK|PREAUTH)/i.test(line)) throw new ImapError('IMAP 服务器应答异常', 'BAD', line);
    return line;
  }

  /** 登录：被服务器拒绝（NO）映射为 AUTH 状态，供上层提示「授权码错误或 IMAP 服务未开启」。 */
  async login(user, password) {
    const res = await this._run(`LOGIN ${quoteArg(user)} ${quoteArg(password)}`);
    if (!res.ok) throw new ImapError('授权码错误或 IMAP 服务未开启', 'AUTH', res.text);
  }

  /**
   * 发送 IMAP ID（RFC 2971）声明客户端身份。网易系（163/126/yeah）硬性要求：
   * 登录后不带 ID 直接 SELECT 会被拒 `NO SELECT Unsafe Login`（官方帮助中心确认）。
   * ID 是声明性命令：个别服务器不识别（BAD/NO）时容忍返回 false 继续后续流程；
   * 服务器的 `* ID (…)` 未标记应答由 _run 分发后忽略，只需等到标记行。
   */
  async id() {
    const res = await this._run('ID ("name" "MergeInvoice-Web" "version" "1.0.0" "vendor" "MergeInvoice")');
    return res.ok;
  }

  /** 选择 INBOX；网易 Unsafe Login 拒绝给出可操作的中文指引而非裸英文详情。 */
  async selectInbox() {
    const res = await this._run('SELECT INBOX');
    if (!res.ok) {
      if (/Unsafe\s+Login/i.test(res.text)) {
        throw new ImapError('邮箱判定当前登录环境不安全（Unsafe Login）：请在网页版邮箱查看安全提醒并按提示放行，或稍后重试', res.status, res.text);
      }
      throw new ImapError('无法打开收件箱', res.status, res.text);
    }
  }

  /**
   * 按时间范围搜索 UID（结束日含当日：BEFORE 为开区间，调用方传 endDate + 1 天）。
   * 支持 `* SEARCH` 折行（后续行以空格开头）。
   */
  async search(since, before) {
    const uids = [];
    const collect = (text) => {
      const tokens = text.trim().split(/\s+/);
      for (const token of tokens) {
        if (/^\d+$/.test(token)) uids.push(Number(token));
      }
    };
    const res = await this._run(
      `UID SEARCH SINCE ${formatImapDate(since)} BEFORE ${formatImapDate(before)}`,
      (ev) => {
        if (ev.kind === 'line' && /^\*\s+SEARCH\b/i.test(ev.text)) {
          collect(ev.text.replace(/^\*\s+SEARCH\b/i, ''));
        } else if (ev.kind === 'cont') {
          collect(ev.text);
        }
      }
    );
    if (!res.ok) throw new ImapError('IMAP 搜索失败', res.status, res.text);
    return uids;
  }

  /**
   * 批量取邮件头 + BODYSTRUCTURE → [{ uid, headers, structure, names }]。
   * structure 为原始 BODYSTRUCTURE 文本，前端据此预判是否含 PDF/ZIP 附件
   * （避免把无附件邮件列进结果表）；names 为附件名参数（供前端关键词匹配）。
   * headers 的主题/发件人 RFC2047 解码交给前端 mime.js。
   */
  async fetchHeaders(uids) {
    const out = [];
    const command = `UID FETCH ${uids.join(',')} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`;
    const res = await this._run(command, (ev) => {
      if (ev.kind !== 'fetch') return;
      const text = ev.segments.join('\n');
      const m = /UID\s+(\d+)/i.exec(text);
      if (!m) return;
      const structure = extractStructure(text);
      out.push({
        uid: Number(m[1]),
        headers: headerBytesToString(pickHeaderLiteral(ev.literals)),
        structure,
        names: extractAttachmentNames(structure)
      });
    });
    if (!res.ok) throw new ImapError('IMAP 获取邮件头失败', res.status, res.text);
    return out;
  }

  /** 取单封邮件原始字节（BODY.PEEK[] 不改变 \Seen 标志）。 */
  async fetchFull(uid) {
    let message = null;
    const res = await this._run(`UID FETCH ${uid} (UID BODY.PEEK[])`, (ev) => {
      if (ev.kind === 'fetch' && ev.literals.length > 0) message = ev.literals[0];
    });
    if (!res.ok) throw new ImapError('IMAP 获取邮件内容失败', res.status, res.text);
    if (!message) throw new ImapError('IMAP 未返回邮件内容', 'EMPTY', res.text);
    return message;
  }

  /**
   * 从候选 UID（新的在前）里筛出含 PDF/ZIP 附件的邮件：分批 FETCH
   * （BODYSTRUCTURE + 邮件头），凑满 limit 即停，最多检查 maxScan 封。
   * 这样服务端就不会把返回额度浪费在无附件邮件上。
   */
  async collectAttachmentMails(uids, { limit = 200, batchSize = 100, maxScan = 1000 } = {}) {
    const picked = [];
    const scan = uids.slice(0, maxScan);
    for (let i = 0; i < scan.length && picked.length < limit; i += batchSize) {
      const batch = scan.slice(i, i + batchSize);
      const fetched = await this.fetchHeaders(batch);
      // 服务器可能不保证返回顺序，统一按 UID 倒序后再累积
      fetched.sort((a, b) => b.uid - a.uid);
      for (const item of fetched) {
        if (picked.length >= limit) break;
        if (structureLooksLikeAttachment(item.structure)) picked.push(item);
      }
    }
    return picked;
  }

  /** LOGOUT 并关闭写端（尽力而为，异常向上抛由调用方兜底）。 */
  async logout() {
    try {
      await this._run('LOGOUT');
    } finally {
      try {
        await this.writer.close();
      } catch {
        /* noop：连接可能已被服务器关闭 */
      }
    }
  }

  /** 发送命令并读到同 tag 的标记行；onEvent 分发未标记响应。 */
  async _run(command, onEvent) {
    const tag = `A${String(++this.tagSeq).padStart(3, '0')}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    for (;;) {
      const line = await this.reader.readLine();
      if (line.startsWith(`${tag} `)) {
        const text = line.slice(tag.length + 1);
        const ok = /^OK\b/i.test(text);
        let status = 'ERR';
        if (ok) status = 'OK';
        else if (/^NO\b/i.test(text)) status = 'NO';
        else if (/^BAD\b/i.test(text)) status = 'BAD';
        return { ok, status, text };
      }
      if (line.startsWith('*')) {
        if (/^\*\s+\d+\s+FETCH\s+\(/i.test(line)) {
          const parts = await this._readFetch(line);
          if (onEvent) onEvent({ kind: 'fetch', segments: parts.segments, literals: parts.literals });
        } else if (onEvent) {
          onEvent({ kind: 'line', text: line });
        }
        continue;
      }
      if (line.startsWith('+')) {
        throw new ImapError('IMAP 服务器请求延续输入，已中止', 'BAD');
      }
      if (line.startsWith(' ')) {
        if (onEvent) onEvent({ kind: 'cont', text: line }); // SEARCH 折行续段
        continue;
      }
      // 其它未知行忽略，继续等标记行
    }
  }

  /**
   * 读取一条 FETCH 响应：行尾带 {n} 时先读 n 字节字面量再续行，
   * 按括号差值消费到响应闭合。segments 为文本段（供解析 UID），
   * literals 为字面量原始字节（邮件头 / 邮件正文）。
   */
  async _readFetch(firstLine) {
    const segments = [firstLine];
    const literals = [];
    let balance = parenBalance(firstLine);
    let guard = 0;
    while (balance > 0) {
      guard += 1;
      if (guard > 100) throw new ImapError('IMAP FETCH 响应结构异常', 'BAD');
      const tail = segments[segments.length - 1];
      const literal = /\{(\d+)\}\s*$/.exec(tail);
      if (literal) literals.push(await this.reader.readBytes(Number(literal[1])));
      const next = await this.reader.readLine();
      segments.push(next);
      balance += parenBalance(next);
    }
    return { segments, literals };
  }
}
