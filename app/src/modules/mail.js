// 邮箱服务商预设与 Worker API 客户端（搜索邮件头 / 取原始邮件字节）。
// 仅与自建 Cloudflare Worker 通信（默认同源 /api，可在对话框高级设置里改为分域地址）；
// 失败统一抛 MailError，code 供 UI 区分「未部署后端 / 令牌 / 授权码 / 网络 / 服务端」。
// 关键词过滤与头解码也放这里（纯函数，便于 node --test 覆盖）。
import { decodeMimeWords, parseMessageHeaders } from './mime.js';

/** 支持的服务商（与 Worker 端主机白名单一一对应）。 */
export const MAIL_PROVIDERS = [
  { id: '163', label: '网易 163 邮箱' },
  { id: '126', label: '网易 126 邮箱' },
  { id: 'yeah', label: '网易 yeah 邮箱' },
  { id: 'qq', label: 'QQ 邮箱' }
];

/** 默认 API 基址：同源部署直接用 /api；分域部署填 Worker 完整地址（配合 Worker 的 ALLOW_ORIGIN）。 */
export const DEFAULT_API_BASE = '/api';

/** 邮箱 API 错误：code 取值 network / no-backend / auth / token / bad-request / server。 */
export class MailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MailError';
    this.code = code || 'server';
  }
}

/** 搜索邮件头 → [{ uid, headers }]（headers 为原文，用 decodeMessages 解出中文主题）。 */
export async function searchMail({ provider, email, code, startDate, endDate, apiBase, token }) {
  const res = await send(
    '/mail/search',
    { provider, email, code, startDate, endDate },
    { apiBase, token }
  );
  if (!res.ok) throw await readError(res);
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.messages)) throw new MailError('邮箱服务响应格式异常', 'server');
  return data.messages;
}

/** 取单封邮件原始 RFC822 字节 → Uint8Array。 */
export async function fetchRaw({ provider, email, code, uid, apiBase, token }) {
  const res = await send('/mail/raw', { provider, email, code, uid }, { apiBase, token });
  if (!res.ok) throw await readError(res);
  return new Uint8Array(await res.arrayBuffer());
}

// —— 结果加工（纯函数） ——

/** 解码搜索结果邮件头 → [{ uid, subject, from, date, structure, names }]（RFC2047 中文解码 + 附件名解码）。 */
export function decodeMessages(rawMessages) {
  return rawMessages.map((item) => {
    const headers = parseMessageHeaders(item.headers);
    return {
      uid: item.uid,
      subject: decodeMimeWords(headers.subject) || '（无主题）',
      from: decodeMimeWords(headers.from),
      date: headers.date,
      structure: typeof item.structure === 'string' ? item.structure : null,
      names: Array.isArray(item.names) ? item.names.map(decodeParamValue).filter(Boolean) : []
    };
  });
}

/** 附件名解码：先按 RFC2231（charset''百分号编码）还原，再按 RFC2047 解码。 */
function decodeParamValue(value) {
  if (typeof value !== 'string' || !value) return '';
  let text = value;
  const rfc2231 = /^[^']*'[^']*'(.*)$/.exec(value);
  if (rfc2231) text = rfc2231[1];
  if (rfc2231 || text.indexOf('%') >= 0) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* 非法百分号编码：保留原值 */
    }
  }
  return decodeMimeWords(text) || '';
}

/**
 * 关键词拆分：中英文逗号/分号/空白分隔，小写化；英文引号包裹视为短语（可含空格）。
 * 空输入返回空数组（= 不过滤）。
 */
export function parseKeywords(text) {
  if (!text) return [];
  const words = [];
  const re = /"([^"]*)"|([^\s,，;；]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const word = (m[1] !== undefined ? m[1] : m[2]).trim().toLowerCase();
    if (word) words.push(word);
  }
  return words;
}

/**
 * 关键词本地过滤（IMAP 中文 SUBJECT 搜索编码不可靠，故在前端做）：
 * 命中主题、发件人或附件文件名任一即保留；无关键词时原样返回（不改变顺序）。
 */
export function filterByKeywords(messages, keywords) {
  const words = parseKeywords(keywords);
  if (words.length === 0) return messages.slice();
  return messages.filter((message) => {
    const names = Array.isArray(message.names) ? message.names.join(' ') : '';
    const haystack = `${message.subject}\n${message.from}\n${names}`.toLowerCase();
    return words.some((word) => haystack.indexOf(word) >= 0);
  });
}

/**
 * 依据 BODYSTRUCTURE 预判是否可能含 PDF/ZIP 附件（结果表只展示可能含附件的邮件）。
 * 原则：宁可多列，绝不漏掉真实发票。满足任一条件即视为「可能有附件」：
 * 1) 含任意 application/* 部件（PDF、ZIP、X-ZIP-COMPRESSED、OCTET-STREAM 打包等）；
 * 2) 任意引号串以 .pdf/.zip 结尾（部分服务端只给名称参数，或 RFC2231 百分号编码名）；
 * 3) 结构缺失、或结构里含字面量占位 `{n}`（BODYSTRUCTURE 以字面量返回，解析不完整）。
 */
export function structureHasAttachment(structure) {
  if (!structure) return true;
  const upper = structure.toUpperCase();
  if (upper.indexOf('{') >= 0) return true;
  if (/"APPLICATION"/.test(upper)) return true;
  return /"[^"]*\.(PDF|ZIP)[^"]*"/.test(upper);
}

/**
 * 搜索结果排序：按邮件 Date 头倒序（最近日期在前）；Date 缺失/无法解析时视为最旧，
 * 保证顺序确定（同日期再按 UID 倒序，≈ 收信先后）。返回新数组，不改变入参。
 */
export function sortMessagesNewestFirst(messages) {
  const time = (value) => {
    const parsed = Date.parse(value || '');
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return messages.slice().sort((a, b) => {
    const diff = time(b.date) - time(a.date);
    if (diff !== 0) return diff;
    return (b.uid || 0) - (a.uid || 0);
  });
}

/** 邮件 Date 头展示格式化：可解析则「YYYY-MM-DD HH:mm」（本地时区），否则原样返回。 */
export function formatMailDate(raw) {
  if (!raw) return '';
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return raw;
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// —— 内部 ——

/** 规范化 API 基址（去尾部斜杠；空值回退默认同源 /api）。 */
function resolveBase(apiBase) {
  const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

/** POST JSON 到 Worker；网络层失败抛 MailError(network)，404 抛 no-backend（未部署引导）。 */
async function send(path, body, { apiBase, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${resolveBase(apiBase)}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (res.status === 404) {
      throw new MailError(
        '未检测到邮箱后端服务（HTTP 404）：该功能需部署 Cloudflare Worker，部署方法见对话框内「设置说明」或仓库 docs/mail-import.md',
        'no-backend'
      );
    }
    return res;
  } catch (err) {
    if (err instanceof MailError) throw err;
    throw new MailError('无法连接邮箱服务，请检查网络或 API 地址设置', 'network');
  }
}

/** 非 2xx 响应 → MailError：优先取服务端中文 error 文案，按状态码归类。 */
async function readError(res) {
  let message = '';
  const contentType = res.headers.get('content-type') || '';
  if (contentType.indexOf('json') >= 0) {
    const data = await res.json().catch(() => null);
    if (data && typeof data.error === 'string') message = data.error;
  }
  if (!message) message = `邮箱服务返回 HTTP ${res.status}`;
  return new MailError(message, classifyStatus(res.status, message));
}

/** HTTP 状态归类：401 再按文案区分授权码问题 vs 访问令牌问题。 */
function classifyStatus(status, message) {
  if (status === 401) return message.indexOf('授权码') >= 0 ? 'auth' : 'token';
  if (status === 400) return 'bad-request';
  return 'server';
}
