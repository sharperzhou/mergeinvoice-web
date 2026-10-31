import assert from 'node:assert/strict';
import { test } from 'node:test';

// 模拟旧版移动端浏览器：移除 pdf.js 4.2 依赖的新内置 API，验证 pdfjs-compat.js 能补齐
// （node --test 每个测试文件独立进程，删除内置方法不影响其他测试）
test('pdfjs-compat 在缺失时补齐 pdf.js 依赖的新 API', async () => {
  delete Promise.withResolvers;
  delete Array.prototype.at;
  delete String.prototype.at;
  delete globalThis.structuredClone;

  assert.equal(typeof Promise.withResolvers, 'undefined', '前置条件：API 已被移除');
  assert.equal(typeof Array.prototype.at, 'undefined');
  assert.equal(typeof globalThis.structuredClone, 'undefined');

  await import('../app/src/modules/pdfjs-compat.js');

  // Promise.withResolvers
  assert.equal(typeof Promise.withResolvers, 'function');
  const { promise, resolve, reject } = Promise.withResolvers();
  assert.equal(typeof resolve, 'function');
  assert.equal(typeof reject, 'function');
  resolve(42);
  assert.equal(await promise, 42, 'resolve 应生效');

  // Array.prototype.at / String.prototype.at
  assert.equal([1, 2, 3].at(-1), 3, 'Array.prototype.at 负数索引');
  assert.equal([1, 2, 3].at(1), 2, 'Array.prototype.at 正数索引');
  assert.equal('abc'.at(-1), 'c', 'String.prototype.at');

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
