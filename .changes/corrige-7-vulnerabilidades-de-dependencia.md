---
impacto: nada_mudou
secao: corrigido
titulo: Sete vulnerabilidades de dependência transitiva corrigidas (fast-uri, qs, browserslist)
---

O GitHub apontou 7 advisories abertos no repo: 4 em `fast-uri` (host confusion /
SSRF via normalização de URI malformada), 2 em `qs` (bypass de limite de array,
DoS via `isBuffer`) e 1 em `browserslist` (crash / escrita de protótipo com
`browserslist-stats.json` não confiável). Nenhum dos três é dependência direta
— chegam via `ajv`/`@modelcontextprotocol/sdk`, `express`/`express-rate-limit`
e `autoprefixer`/`eslint-config-next`, respectivamente.

Os três entraram no piso de versão já existente em `package.json#pnpm.overrides`
(mesmo mecanismo que já fixava `postcss`, `sharp`, `hono`, `js-yaml` etc.), sem
subir de major: `fast-uri@^3.1.7`, `qs@^6.16.0`, `browserslist@^4.28.8`.

Nada muda para quem opera uma instalação: são versões patch de dependência
transitiva, sem migration nem passo de atualização.
