// Pages Functions：把站点下的 /api/* 请求通过 Service Binding 内部转发给 Worker。
// 目的：前端与邮箱 API 同域（mergeinvoice.pages.dev），不依赖被 DNS 污染的 *.workers.dev。
// 前置：Pages 项目 Settings → Functions → Service bindings 添加绑定：
//   变量名 API → 目标服务（你的 Worker，如 merge-invoice-web）
// 绑定缺失时返回明确的 500 提示，前端会把 error 文案展示出来。
export async function onRequest(context) {
  const { request, env } = context;
  if (!env.API) {
    return new Response(
      JSON.stringify({
        error: '未配置邮箱 API 服务绑定：请在 Pages 项目 Settings → Functions → Service bindings 添加 API → 你的 Worker'
      }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
  return env.API.fetch(request);
}
