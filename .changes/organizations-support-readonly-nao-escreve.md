---
impacto: nada_mudou
secao: corrigido
titulo: Quem tem acesso só de leitura ao painel de plataforma deixa de conseguir alterar empresas e outros dados pela API
---
`fn_is_platform_admin()` ignorava o scope do JWT. Um platform admin com `scope=support_readonly` alterava colunas de exibição e `settings` de organizations (e escrevia em outras tabelas admin de plataforma) com o próprio token, sem passar por `security definer` nem gatilho.

- Cria `fn_is_platform_admin_full()` — idêntica à atual, exigindo `scope='full'`.
- Policies de **escrita** de organizations (e as 14 políticas de escrita da base original) passam a usar `fn_is_platform_admin_full()`. A leitura (FOR SELECT) continua com `fn_is_platform_admin()`, então `support_readonly` segue lendo — só não escreve.
- Nas 6 tabelas cuja única policy era `FOR ALL` (api_tokens, nuvemshop_products, incidents, ai_invocations, contacts, channel_session_warmup), o par vira `_read` (SELECT) + `_write` (`_full`).
- Invariante em Postgres real (dk-harness, migração 0508): `support_readonly` → **0 linhas alteradas** em organizations; `full` → continua escrevendo.

Contribuição de @webtecnica (#2078).
