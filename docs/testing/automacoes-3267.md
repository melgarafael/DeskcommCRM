# Provas do resgate de automações #3267 / #3522

A fonte autoral `7ca04fa958186e9471f8723ae9698ae3b7dc7e64` permanece na história. A decisão 203A autoriza somente os três diffs protegidos já examinados; esses arquivos continuam iguais à fonte. A integração normal preserva a main `3b3bec7d66acea1299fb09baaea8797c7b691913`, incluindo as propostas de campos de #3476.

## Tipos reais

O [recibo da geração](../../evidence/automacoes-3267/typegen-real-3522.json) declara os dois pais do merge, o hash do baseline combinado e os hashes bruto e formatado. Um Postgres 17.11 novo aplicou o prelude canônico e o baseline completo em instalação e atualização, ambos com `ON_ERROR_STOP=1`. O CLI Supabase 2.122.0 gerou `public` duas vezes com bytes idênticos; ambas as saídas foram formatadas com o Prettier do candidato antes da cópia integral para `lib/database.types.ts`.

Contra os tipos da main, o delta é de 67 linhas acrescentadas: `automation_rule_contact_claims`, `automation_rule_runs.contact_id` anulável e sua relação. Os demais contratos públicos e o membro completo `lead_field_proposals` permanecem idênticos. O banco próprio teve limite de 1 GiB, uma CPU e porta somente em localhost; contêiner e porta foram removidos ao terminar. Nenhum tipo foi ajustado à mão.

## Falhas de harness e reparos

No head de origem `d4c35ceb0c37c7065e38f84c83c02788b36f4585`, o [verify](https://github.com/melgarafael/DeskcommCRM/actions/runs/40422574182/job/121920325929) parou porque o `fetch` nativo expõe `ok` como booleano. O teste agora lê essa propriedade; chamadas `APIResponse.ok()` do Playwright permanecem com sua API original.

A [parte 3 do E2E](https://github.com/melgarafael/DeskcommCRM/actions/runs/40422574146/job/121921396931) recusou `trace` e `video` dentro de `describe`. A derivação de `test` no escopo do arquivo desliga esses registros somente no cenário que emite bearers sintéticos. A captura de tela explícita e todas as asserções permanecem. A coleção pelo Playwright instalado 1.64.1, com configuração própria e credenciais sintéticas, reproduziu a recusa e passou a listar os dois casos; não iniciou navegador, servidor ou seed.

Os [PG15](https://github.com/melgarafael/DeskcommCRM/actions/runs/40422574182/job/121924084076) e [PG17](https://github.com/melgarafael/DeskcommCRM/actions/runs/40422574182/job/121924084070) tiveram uma falha de parser no novo invariante de recibos históricos. Um controle real de `json_agg` no Postgres confirmou newline legítimo entre os registros. O parser agora lê o JSON completo entre os marcadores de recibo e auditoria, preservando os dois registros e as duas passadas. O SQL do produto e as asserções de conteúdo, concorrência e auditoria não mudaram.

## Limites atuais

Os 22 arquivos dirigidos de tipos, leitores e automações passaram: 217 testes, um worker e heap de 1536 MiB. ESLint dos dois testes reparados e `git diff --check` passaram. Os controles do parser rejeitam JSON inválido e demonstram a falha do leitor antigo com a saída bruta real.

A navegação real, a captura visual e as matrizes completas de banco do candidato final continuam dependentes do próximo CI oficial. Coleção de testes e geração de tipos não são prova visual. Não houve build local, instalação de dependências, Docker no Mac, alteração de ambiente ou publicação de site.
