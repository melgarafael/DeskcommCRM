import html from './index.html';
const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET','HEAD'].includes(request.method)) return fetch(request);
    if (url.pathname === '/') return new Response(request.method === 'HEAD' ? null : html, {headers});
    if (url.pathname === '/_escreve/logo.png') {
      const assetUrl = new URL('/logo.png', request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return fetch(request);
  }
};
