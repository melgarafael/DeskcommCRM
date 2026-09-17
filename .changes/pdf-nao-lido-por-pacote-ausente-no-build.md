---
impacto: nada_mudou
secao: corrigido
titulo: PDF com texto selecionável deixa de ser recusado como "só imagens escaneadas"
---

Ao anexar um PDF em Ensinar algo novo ao agente, todo arquivo — mesmo um com texto normal,
selecionável — era recusado com "não consegui extrair texto deste PDF. Se ele for só imagens
escaneadas...". A causa não era o arquivo: o `pdfjs-dist`, a biblioteca que lê o PDF, saía
inteiro do build de produção (`next build` no modo standalone), porque o rastreador de
dependências do Next não segue o `import()` que essa biblioteca usa para o subcaminho que o
projeto carrega. O pacote simplesmente não chegava na imagem Docker, e todo PDF — com ou sem
texto — falhava do mesmo jeito.

Agora o build inclui o pacote explicitamente, do mesmo jeito que já era feito para o
`@napi-rs/canvas` e o `@swc/helpers` — e mais um passo que só apareceu testando o caminho real
de produção (o Turbopack bundla o pdfjs-dist num chunk próprio, e esse chunk procura o
`pdf.worker.mjs` do pdf.js como arquivo vizinho dentro de `.next/server/chunks/`, não em
`node_modules/`). PDFs com texto selecionável voltam a ser lidos; a mensagem de "só imagens
escaneadas" volta a aparecer só quando o PDF É, de fato, só imagem. Provado com um PDF real de
170 páginas, extraindo texto de ponta a ponta pelo mecanismo de carregamento de chunk que a
produção usa.
