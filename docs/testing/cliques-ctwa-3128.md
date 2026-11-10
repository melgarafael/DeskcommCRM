# Cliques CTWA — integração e limites da prova

A contribuição de @oianmaxdev (#3128) permanece creditada. Cada clique válido tem identidade própria, preserva o card do lead aberto e respeita a ativação da organização, desligada por padrão. A spec causal usa WAHA assinado, Supabase real e Graph local; HTTP 200 do receiver não comprova aceite ou atribuição pela Meta.

## Reparos causais de CI

O failover APT já aprovado na main corrige o preparo que falhou antes do Playwright. Imports estáticos no harness corrigem o carregamento do coletor, sem adaptar implementação produtiva para o runner.

A coleta real encontrou honorários não instalado. O reparo aprovado aceita somente `42P01`/`PGRST205` na tabela inicial opcional. Permissão, coluna ausente, erro desconhecido, tabela CTWA obrigatória e parcelas ausentes com contratos presentes continuam impedindo export incompleto. Os controles dirigidos passaram. O log antigo preservou mensagem, sem código bruto; não é apresentado como observação de `PGRST205`.

A sonda nova usa SDK real separado sem generic core somente para a tabela opcional, mantendo orgfilter, auth sem persistência e captura de `status/error`. Core segue tipado. O typecheck integral de `71aabc3b1577c29d520f787495fece4902dd97be` passou no [verify1](https://github.com/melgarafael/DeskcommCRM/actions/runs/40428084893/job/121938763347). Resposta bruta HTTP e duas PNGs ainda dependem do E2E8; não são alegadas aqui.

## Composição LGPD e fixture central

A 0806 não substitui a cascata LGPD: seu gatilho independente apaga cliques por organização/contato na virada de `is_anonymized`. A última função da main, incluindo propostas/valores/`motivo_recusa`, foi preservada byte a byte. Migrations 0803–0806 intactas; apêndices 0805/0806 exatos e anteriores à varredura final.

O commit central `7c14d268a30e8a8defac4989d17864efae11c122` ([PR #3530](https://github.com/melgarafael/DeskcommCRM/pull/3530), doc222=A) entra por merge normal. As oito linhas mudam só a fixture de retenção, com janela de 24h em UTC e cleanup próprio; todas as assertivas permanecem. O patch passou 12 casos em PG17 real com install/update, sem mudar relógio ou regra de envio.

## Tipos completos gerados

O baseline de `71aabc`, SHA256 `f539818ce577987a4e5a3067e6d6bc71f7974b98de20fd19cd757caefb195e14`, recebeu prelude canônico e install/update com `ON_ERROR_STOP=1` em PG17.11 descartável. CLI 2.122.0 gerou o schema público duas vezes com saídas idênticas: raw SHA256 `506f559b96e918d57610407f0a9ba2f885adb2c34993ffed536a74a7ea40efe3`.

A cópia inteira foi formatada mecanicamente com Prettier 3.9.10: SHA256 `b77d15778666ed6ce6ad2f6e9362469a5e0549f7167ab4fa9102a507f7d4e0f2`. AST: 207 tabelas e 256 funções, incluindo propostas e `tags_do_contato`; nenhum objeto/campo canônico perdido. O delta é somente `meta_ctwa_click_dispatches` e oito RPCs da feature. O merge central não mudou o baseline medido. Não foram unidos hunks; raws, origem e hashes permanecem no recibo da operação.

## Pendências do head final

Faltam cinco checks finais, sucesso do caso E2E8, resposta bruta PostgREST e duas PNGs próprias. O PR continua DRAFT, sem auto-merge. Transporte controlado não comprova entrega externa ou atribuição pela Meta.

A coleta futura do CI fixa isoladamente CLI 2.122.0 pelo helper próprio, sem alterar dependências, lock ou a versão da stack. O DSN numérico local é validado antes de acrescentar `sslmode=disable` com URLSearchParams. A AST confere a tabela própria, propostas e o campo computado; os brutos 2.122 passaram e o bruto 2.117 sem o campo foi recusado. O transporte externo não recebe essa exceção TLS.
