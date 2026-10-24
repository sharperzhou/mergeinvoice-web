import assert from 'node:assert/strict';
import { test } from 'node:test';

// 模拟旧版移动端浏览器：移除较新的内置 API，验证 polyfills.js 能补齐
// （node --test 每个测试文件独立进程，删除内置方法不影响其他测试）
test('polyfills 在缺失时补齐 Promise.withResolvers 等 API', async () => {
  delete Promise.withResolvers;
  delete Array.prototype.at;
  delete String.prototype.at;
  delete Array.prototype.findLast;
  delete Array.prototype.findLastIndex;
  delete Object.hasOwn;

  assert.equal(typeof Promise.withResolvers, 'undefined', '前置条件：API 已被移除');

  await import('../src/modules/polyfills.js');

  assert.equal(typeof Promise.withResolvers, 'function', '应补上 Promise.withResolvers');
  const { promise, resolve, reject } = Promise.withResolvers();
  assert.equal(typeof resolve, 'function');
  assert.equal(typeof reject, 'function');
  resolve(42);
  assert.equal(await promise, 42, 'resolve 应生效');

  assert.equal([1, 2, 3].at(-1), 3, 'Array.prototype.at');
  assert.equal('abc'.at(-1), 'c', 'String.prototype.at');
  assert.equal([{ v: 1 }, { v: 2 }].findLast((item) => item.v < 2).v, 1, 'findLast');
  assert.equal([1, 2, 3].findLastIndex((v) => v < 3), 1, 'findLastIndex');
  assert.equal(Object.hasOwn({ a: 1 }, 'a'), true, 'Object.hasOwn');
  assert.equal(Object.hasOwn({ a: 1 }, 'b'), false);
});
