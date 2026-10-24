import assert from 'node:assert/strict';
import { test } from 'node:test';

// 模拟旧版移动端浏览器：移除较新的内置 API，验证 polyfills.js 能补齐
// （node --test 每个测试文件独立进程，删除内置方法不影响其他测试）
test('polyfills 在缺失时补齐 pdf.js 依赖的新 API', async () => {
  delete Promise.withResolvers;
  delete Promise.try;
  delete URL.parse;
  delete Array.prototype.at;
  delete String.prototype.at;
  delete Array.prototype.findLast;
  delete Array.prototype.findLastIndex;
  delete Object.hasOwn;
  delete Set.prototype.intersection;
  delete Set.prototype.union;
  delete Set.prototype.difference;
  delete Set.prototype.isSubsetOf;
  delete globalThis.structuredClone;

  assert.equal(typeof Promise.withResolvers, 'undefined', '前置条件：API 已被移除');
  assert.equal(typeof URL.parse, 'undefined');
  assert.equal(typeof globalThis.structuredClone, 'undefined');

  await import('../src/modules/polyfills.js');

  // Promise.withResolvers / Promise.try
  assert.equal(typeof Promise.withResolvers, 'function');
  const { promise, resolve, reject } = Promise.withResolvers();
  assert.equal(typeof resolve, 'function');
  assert.equal(typeof reject, 'function');
  resolve(42);
  assert.equal(await promise, 42, 'resolve 应生效');
  assert.equal(await Promise.try((a, b) => a + b, 1, 2), 3, 'Promise.try 应同步返回结果');
  await assert.rejects(() => Promise.try(() => { throw new Error('boom'); }), /boom/, '同步异常应转为 rejected');

  // URL.parse：成功返回 URL，失败返回 null
  assert.equal(URL.parse('https://example.com/a').pathname, '/a');
  assert.equal(URL.parse('/rel', 'https://example.com').href, 'https://example.com/rel', '支持 base 参数');
  assert.equal(URL.parse('http://example.com:8080/x?y=1').port, '8080', '合法 URL 应解析成功');
  assert.equal(URL.parse('::not-a-url::'), null, '非法 URL 应返回 null');

  // 数组 / 字符串 / 对象方法
  assert.equal([1, 2, 3].at(-1), 3, 'Array.prototype.at');
  assert.equal('abc'.at(-1), 'c', 'String.prototype.at');
  assert.equal([{ v: 1 }, { v: 2 }].findLast((item) => item.v < 2).v, 1, 'findLast');
  assert.equal([1, 2, 3].findLastIndex((v) => v < 3), 1, 'findLastIndex');
  assert.equal(Object.hasOwn({ a: 1 }, 'a'), true, 'Object.hasOwn');
  assert.equal(Object.hasOwn({ a: 1 }, 'b'), false);

  // Set 集合运算
  assert.deepEqual([...new Set([1, 2, 3]).intersection(new Set([2, 3, 4]))], [2, 3], 'intersection');
  assert.deepEqual([...new Set([1, 2]).union(new Set([2, 3]))], [1, 2, 3], 'union');
  assert.deepEqual([...new Set([1, 2, 3]).difference(new Set([2]))], [1, 3], 'difference');
  assert.equal(new Set([1, 2]).isSubsetOf(new Set([1, 2, 3])), true, 'isSubsetOf');
  assert.equal(new Set([1, 2, 3]).isSupersetOf(new Set([1, 2])), true, 'isSupersetOf');

  // structuredClone：深拷贝 Map / Set / Date / 数组 / 普通对象，且与源对象不共享引用
  const source = { list: [1, { deep: true }], map: new Map([['a', 1]]), set: new Set([1]), date: new Date(0) };
  const copy = structuredClone(source);
  assert.notEqual(copy, source);
  assert.notEqual(copy.list, source.list);
  assert.equal(copy.list[1].deep, true);
  assert.equal(copy.map.get('a'), 1);
  assert.equal(copy.set.has(1), true);
  assert.equal(copy.date.getTime(), 0);
});
