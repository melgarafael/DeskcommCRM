---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de cobrança não se perde quando a leitura da empresa lança
---

A rota do aviso de cobrança gravava o ponteiro quando a leitura da empresa
devolvia erro e quando não encontrava a empresa, mas não quando ela LANÇAVA —
cliente do banco sem rede, `fetch` abortado, resposta fora do contrato. Nesse
caso a exceção subia, a resposta era 500 e o aviso ia embora sem rastro nenhum
no arquivo de avisos.

Agora a exceção cai no mesmo caminho do erro: o ponteiro fica gravado como
`received`, com o motivo, e o erro vai ao log só com o tipo da falha. A
reentrega do provedor fecha a mesma linha pelo índice de idempotência. O corpo e
os cabeçalhos continuam fora do arquivo, como manda a especificação da cobrança
(§2.4) — o que mudou é que a falha de leitura não engole mais o registro.
