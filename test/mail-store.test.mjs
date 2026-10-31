import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearCred,
  clearKeywords,
  CRED_TTL_MS,
  DEFAULT_KEYWORDS,
  getKeywords,
  getUiPrefs,
  getValidCred,
  readCred,
  saveCred,
  setKeywords,
  setUiPrefs,
  touchCred
} from '../app/src/modules/mail-store.js';

// 邮箱本地存储：授权码 60 天滑动过期、关键词永存、界面偏好持久

/** 内存版 localStorage（测试注入，含 getItem/setItem/removeItem/clear）。 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _map: map
  };
}

const T0 = 1_700_000_000_000; // 固定基准时刻，避免用例依赖真实时钟

test('保存凭据：expiresAt = 保存时刻 + 60 天，未过期可取回', () => {
  const store = fakeStorage();
  const cred = saveCred('163', 'me@163.com', 'abc123', { storage: store, now: T0 });
  assert.equal(cred.expiresAt, T0 + CRED_TTL_MS);

  const valid = getValidCred('163', { storage: store, now: T0 + CRED_TTL_MS - 1 });
  assert.ok(valid);
  assert.equal(valid.email, 'me@163.com');
  assert.equal(valid.code, 'abc123');
});

test('过期后：返回 null、清 code 留 email 占位', () => {
  const store = fakeStorage();
  saveCred('qq', 'me@qq.com', 'secret', { storage: store, now: T0 });
  const expiredAt = T0 + CRED_TTL_MS;
  assert.equal(getValidCred('qq', { storage: store, now: expiredAt }), null);

  // 残留结构：code 被清、email 保留（下次只需重输授权码）
  const leftover = readCred('qq', { storage: store });
  assert.equal(leftover.email, 'me@qq.com');
  assert.equal(leftover.code, '');
  // 已清空的凭据不可再被「顺延」复活
  assert.equal(touchCred('qq', { storage: store, now: expiredAt + 1 }), false);
});

test('滑动过期：60 天内成功使用自动顺延 60 天', () => {
  const store = fakeStorage();
  saveCred('163', 'me@163.com', 'abc', { storage: store, now: T0 });
  // 第 6 天使用 → 过期时间顺延到 第 13 天
  const used = T0 + 6 * 24 * 60 * 60 * 1000;
  assert.equal(touchCred('163', { storage: store, now: used }), true);
  assert.equal(readCred('163', { storage: store }).expiresAt, used + CRED_TTL_MS);

  // 原始过期时刻（第 60 天）之后仍有效（因为第 6 天顺延过）
  const valid = getValidCred('163', { storage: store, now: T0 + CRED_TTL_MS + 1000 });
  assert.ok(valid);
  // 第 13 天 + 1ms 仍未再次顺延才过期
  assert.equal(getValidCred('163', { storage: store, now: used + CRED_TTL_MS + 1 }), null);
});

test('无凭据时 touchCred 返回 false 不写入', () => {
  const store = fakeStorage();
  assert.equal(touchCred('163', { storage: store, now: T0 }), false);
  assert.equal(store._map.size, 0);
});

test('手动清除凭据', () => {
  const store = fakeStorage();
  saveCred('163', 'a@b', 'x', { storage: store, now: T0 });
  clearCred('163', store);
  assert.equal(readCred('163', { storage: store }), null);
});

test('损坏 JSON / 版本不符：静默重置返回 null', () => {
  const store = fakeStorage();
  store.setItem('mi-mail.cred.163', '{not-json');
  assert.equal(readCred('163', { storage: store }), null);
  assert.equal(store.getItem('mi-mail.cred.163'), null); // 坏键已删除

  store.setItem('mi-mail.cred.163', JSON.stringify({ v: 99, email: 'x', code: 'y', expiresAt: 1 }));
  assert.equal(readCred('163', { storage: store }), null);
  assert.equal(store.getItem('mi-mail.cred.163'), null);
});

test('关键词：无存储回退默认、变更即写、清除恢复默认（永不过期）', () => {
  const store = fakeStorage();
  assert.equal(getKeywords(store), DEFAULT_KEYWORDS);

  setKeywords('滴滴,12306', store);
  assert.equal(getKeywords(store), '滴滴,12306');
  // 关键词没有时间属性——任意「时刻」读取都一致（永存语义）
  assert.equal(getKeywords(store), '滴滴,12306');

  clearKeywords(store);
  assert.equal(getKeywords(store), DEFAULT_KEYWORDS);
});

test('关键词：旧版本默认值迁移为空（默认不过滤）', () => {
  const store = fakeStorage();
  store.setItem('mi-mail.keywords', '滴滴,华住,12306,铁路');
  assert.equal(getKeywords(store), '');
  assert.equal(DEFAULT_KEYWORDS, '');
});

test('界面偏好：合并写入、损坏时回退 null', () => {
  const store = fakeStorage();
  assert.equal(getUiPrefs(store), null);
  setUiPrefs({ startDate: '2026-10-01' }, store);
  setUiPrefs({ endDate: '2026-10-31' }, store);
  assert.deepEqual(getUiPrefs(store), { startDate: '2026-10-01', endDate: '2026-10-31' });

  store.setItem('mi-mail.ui', 'garbage');
  assert.equal(getUiPrefs(store), null);
});

test('存储访问抛错（隐私模式）：各 API 静默降级不抛出', () => {
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    }
  };
  assert.equal(readCred('163', { storage: broken }), null);
  assert.equal(getValidCred('163', { storage: broken, now: T0 }), null);
  assert.equal(saveCred('163', 'a', 'b', { storage: broken, now: T0 }).email, 'a');
  assert.equal(touchCred('163', { storage: broken, now: T0 }), false);
  clearCred('163', broken);
  assert.equal(getKeywords(broken), DEFAULT_KEYWORDS);
  setKeywords('x', broken);
  clearKeywords(broken);
  assert.equal(getUiPrefs(broken), null);
  setUiPrefs({ a: 1 }, broken);
});
