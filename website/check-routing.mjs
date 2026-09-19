import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
const {default:worker} = await import(`data:text/javascript;base64,${Buffer.from(source.replace("import html from './index.html';", 'const html = "<h1>site</h1>";')).toString('base64')}`);
const originalFetch = globalThis.fetch;
let forwarded;
globalThis.fetch = async request => { forwarded = request; return new Response('origin', {status:202}); };
let count=0;
try {
  for (const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) {
    for (const path of ['/','/?utm_source=test','/_escreve/logo.png','/api/webhook','/auth/callback?code=example','/legacy']) {
      forwarded=undefined;
      const request = new Request('https://escreve.ai'+path,{method,headers:{'x-example':'preserved'},...(!['GET','HEAD'].includes(method)?{body:'payload'}:{})});
      const response = await worker.fetch(request,{ASSETS:{fetch: async asset => {
        assert.equal(new URL(asset.url).pathname,'/logo.png');assert.equal(asset.method,method);
        return new Response(method==='HEAD'?null:'logo',{headers:{'Content-Type':'image/png'}});
      }}});
      const own = ['GET','HEAD'].includes(method) && ['/', '/_escreve/logo.png'].includes(new URL(request.url).pathname);
      if (own) {assert.equal(forwarded,undefined);assert.equal(response.status,200);if(method==='HEAD')assert.equal(await response.text(),'');}
      else {assert.equal(forwarded,request);assert.equal(response.status,202);assert.equal(forwarded.headers.get('x-example'),'preserved');if(!['GET','HEAD'].includes(method))assert.equal(await forwarded.text(),'payload');}
      count++;
    }
  }
  console.log(`${count} routing checks passed: home/assets, HEAD, query strings and unchanged legacy requests.`);
} finally {globalThis.fetch=originalFetch;}
