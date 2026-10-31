import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

// Pages Functions 同域代理：/api/* → Service Binding 转发给 Worker

test('缺少 Service Binding 时返回 500 与配置指引', async () => {
  const res = await onRequest({
    request: new Request('https://mergeinvoice.pages.dev/api/mail/search', { method: 'POST' }),
    env: {}
  });
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.match(data.error, /Service bindings/);
});

test('有绑定时原样转发请求并透传响应状态与内容', async () => {
  let seen = null;
  const env = {
    API: {
      fetch: async (request) => {
        seen = request;
        return new Response('forwarded', { status: 201 });
      }
    }
  };
  const request = new Request('https://mergeinvoice.pages.dev/api/mail/raw', {
    method: 'POST',
    body: '{"uid":1}',
    headers: { 'content-type': 'application/json' }
  });
  const res = await onRequest({ request, env });
  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'forwarded');
  assert.equal(seen.url, 'https://mergeinvoice.pages.dev/api/mail/raw');
  assert.equal(seen.method, 'POST');
});
