// 邮箱对话框本地持久化（localStorage）：
// - 授权码 mi-mail.cred.<provider>：默认 60 天过期，成功使用后滑动顺延；
//   过期后清除 code 仅留 email 占位，要求用户重输授权码。
// - 关键词 mi-mail.keywords：无期限保存，仅手动清除或清空浏览器缓存才消失。
// - 界面偏好 mi-mail.ui：起止日期等，无期限保存。
// 所有读写经 try/catch：隐私模式 / 存储被禁时静默降级为「不持久化」。

/** 授权码默认存活期：60 天（毫秒）。 */
export const CRED_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const PREFIX = 'mi-mail.';
const KEY_KEYWORDS = `${PREFIX}keywords`;
const KEY_UI = `${PREFIX}ui`;
const CRED_VERSION = 1;

/** 默认关键词（首次使用或手动清空后回退到此值）。 */
/** 默认关键词：留空（不过滤，显示全部含 PDF/ZIP 附件的邮件）。 */
export const DEFAULT_KEYWORDS = '';

/** 旧版本默认关键词（曾被自动写入存储）：读取时视为「未自定义」，迁移为空。 */
const LEGACY_DEFAULT_KEYWORDS = '滴滴,华住,12306,铁路';

/**
 * 解析存储的凭据（不做过期处理）。
 * 返回 {v, email, code, expiresAt}；键不存在、JSON 损坏、版本不符返回 null。
 * JSON 损坏时顺手删除坏键（静默重置）。
 */
export function readCred(provider, { storage } = {}) {
  const store = resolveStorage(storage);
  if (!store) return null;
  const key = `${PREFIX}cred.${provider}`;
  let raw;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.v !== CRED_VERSION || typeof value.expiresAt !== 'number') {
      store.removeItem(key);
      return null;
    }
    return {
      v: value.v,
      email: typeof value.email === 'string' ? value.email : '',
      code: typeof value.code === 'string' ? value.code : '',
      expiresAt: value.expiresAt
    };
  } catch {
    store.removeItem(key);
    return null;
  }
}

/**
 * 读取当前有效凭据：未过期且 code 非空才返回。
 * 已过期时清掉 code 保留 email 占位（下次打开只需重输授权码），返回 null。
 */
export function getValidCred(provider, { storage, now } = {}) {
  const cred = readCred(provider, { storage });
  if (!cred) return null;
  const time = now === undefined ? Date.now() : now;
  if (cred.expiresAt <= time || !cred.code) {
    if (cred.code) writeCredRaw(provider, { ...cred, code: '' }, storage);
    return null;
  }
  return cred;
}

/**
 * 保存（或覆盖）凭据，过期时间 = now + 60 天。
 * 返回保存后的完整凭据（UI 展示过期时间用）。
 */
export function saveCred(provider, email, code, { storage, now } = {}) {
  const time = now === undefined ? Date.now() : now;
  const cred = { v: CRED_VERSION, email, code, expiresAt: time + CRED_TTL_MS };
  writeCredRaw(provider, cred, storage);
  return cred;
}

/**
 * 成功使用后顺延过期时间（滑动过期）：仅当凭据当前有效时刷新 expiresAt。
 * 返回是否发生了顺延（凭据缺失/已过期不复活，返回 false）。
 */
export function touchCred(provider, { storage, now } = {}) {
  const time = now === undefined ? Date.now() : now;
  const cred = readCred(provider, { storage });
  if (!cred || !cred.code || cred.expiresAt <= time) return false;
  writeCredRaw(provider, { ...cred, expiresAt: time + CRED_TTL_MS }, storage);
  return true;
}

/** 清除指定服务商的凭据（手动清除按钮）。 */
export function clearCred(provider, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(`${PREFIX}cred.${provider}`);
  } catch {
    /* noop */
  }
}

/** 读取关键词：无存储返回默认值（默认空 = 不过滤，永不过期）。 */
export function getKeywords(storage) {
  const store = resolveStorage(storage);
  if (!store) return DEFAULT_KEYWORDS;
  try {
    const raw = store.getItem(KEY_KEYWORDS);
    if (raw === null || raw === undefined) return DEFAULT_KEYWORDS;
    // 老版本默认值迁移：用户从未改过时按空处理，避免默认过滤漏掉发票
    return raw === LEGACY_DEFAULT_KEYWORDS ? DEFAULT_KEYWORDS : raw;
  } catch {
    return DEFAULT_KEYWORDS;
  }
}

/** 保存关键词（变更即时写入，无期限）。 */
export function setKeywords(value, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(KEY_KEYWORDS, String(value));
  } catch {
    /* noop：写失败则下次仍用默认值 */
  }
}

/** 清除关键词（恢复默认值）。 */
export function clearKeywords(storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(KEY_KEYWORDS);
  } catch {
    /* noop */
  }
}

/** 读取界面偏好（{ startDate, endDate } 等），损坏返回 null。 */
export function getUiPrefs(storage) {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(KEY_UI);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 保存界面偏好（合并写入）。 */
export function setUiPrefs(prefs, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const merged = { ...(getUiPrefs(storage) || {}), ...prefs };
    store.setItem(KEY_UI, JSON.stringify(merged));
  } catch {
    /* noop */
  }
}

// —— 内部 ——

/** 直接写入凭据（不做有效性判断）。写失败静默降级。 */
function writeCredRaw(provider, cred, storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(`${PREFIX}cred.${provider}`, JSON.stringify(cred));
  } catch {
    /* noop：写失败则下次打开需重输，不影响主流程 */
  }
}

/** 取存储后端：显式注入优先（测试），否则用全局 localStorage（访问本身可能在隐私模式下抛错）。 */
function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
