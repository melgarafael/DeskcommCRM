import html from './index.html';
const assets = new Set(['logo.png', 'conversation-sculpture.webp', 'time-for-people.webp', 'film-poster.webp', 'brand-film.mp4', 'home.css', 'home.js']);
const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET','HEAD'].includes(request.method)) return fetch(request);
    if (url.pathname === '/') return new Response(request.method === 'HEAD' ? null : html, {headers});
    const assetName = url.pathname.startsWith('/_escreve/') ? url.pathname.slice('/_escreve/'.length) : null;
    if (assets.has(assetName)) {
      const assetUrl = new URL(`/${assetName}`, request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return fetch(request);
  }
};
