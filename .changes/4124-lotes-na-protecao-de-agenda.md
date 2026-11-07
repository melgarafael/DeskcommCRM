---
impacto: nada_mudou
secao: corrigido
titulo: A proteção de agenda volta a valer em organizações com 430+ contatos abertos
---

A leitura que protege o envio de quem tem compromisso na agenda — a mesma que
alimenta o `risk-watcher` e o radar de risco — montava o `.in()` com **todos os contatos** da organização de uma vez só. O PostgREST devolve a consulta inteira
no header `Content-Location`: a partir de ~430 contatos a URL passa de 16 KB, o
`fetch` do servidor morre com `UND_ERR_HEADERS_OVERFLOW` antes de ler o corpo,
e a proteção virava "indisponível" para todo mundo, a cada rodada. Numa
instalação com 507 contatos abertos o `risk-watcher` parou de atualizar o
estado de risco e o radar ficou sem os compromissos.

A consulta agora vai **em lotes de 100 contatos** — 4.149 bytes de URL por
lote contra os 16.384 do header do Node e os 8.192 do gateway —, com no máximo
quatro lotes em voo. Em 430 contatos são 5 consultas por rodada; em 1.000, 10;
em 5.000, 50. Um lote que falha adia **só quem estava nele**: falha de leitura
continua sendo adiamento, nunca "sem compromisso na agenda". As leituras de
follow-up agendado do radar e da estreia do risco usam a mesma divisão.

Quem aplicou `NODE_OPTIONS=--max-http-header-size=65536` como paliativo pode
manter: ele deixou de ser a garantia.
