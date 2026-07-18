# HANDOFF — Webhooks Universais + Motor de Regras

> ⚠️ **INSTRUÇÃO PERMANENTE (não remover):** Este documento DEVE ser lido no
> INÍCIO de toda sessão que trabalhe nesta feature, e ATUALIZADO + COMMITADO ao
> final de CADA avanço (task concluída, decisão tomada, problema encontrado).
> Regra do Rafael: progresso só conta com PROVA VISÍVEL (output de teste, curl,
> screenshot Playwright). Nada de "implementado" sem evidência registrada aqui.
> Medidas de front-end são verificadas por ferramenta (Playwright
> getBoundingClientRect/getComputedStyle), nunca a olho.
> COMMITAR este arquivo a cada atualização — mudança só no working tree se
> perde quando um subagent limpa a árvore (já aconteceu 1x).

## Contexto fixo

- **Feature:** sistema de Webhooks (inbound de leads + mini motor de regras + outbound) — spec em `docs/superpowers/specs/2026-07-17-webhooks-design.md`.
- **Planos:** `docs/superpowers/plans/2026-07-17-webhooks-backend.md` (13 tasks) e `docs/superpowers/plans/2026-07-17-webhooks-ui.md` (6 tasks). Backend primeiro.
- **Onde:** worktree `/Users/rafaelmelgaco/DeskcommCRM/.claude/worktrees/webhooks`, branch `feat/webhooks-automation` (base origin/main). Checkout principal está no `gov/G4` com trabalho do gov-loop — NÃO tocar nele.
- **Método:** subagent-driven (1 implementer + 1 reviewer por task), ledger em `.superpowers/sdd/progress.md`. Após CADA task: prova na tela pro Rafael + atualizar+commitar este arquivo.
- **Ambiente:** `.env.local` e `.e2e-creds.json` copiados do checkout principal. Testes de invariante rodam em Postgres 17 EFÊMERO construído do `baseline.sql` (`npm run test:invariants`) — prova local real, independente do banco remoto.

## Estado atual

| Task | Status | Prova |
|---|---|---|
| BE-T1 migration 0038 + RLS | ✅ completa (review ok) | `d908636`; 54/54 invariantes PASS incl. 6 novos de RLS 2-tenants |
| BE-T2 drain genérico + retry | ✅ completa (review ok pós-fix) | `e2b487c`+`9717b65`; 63/63 PASS (9 casos drain); fixes: NULL next_attempt_at drena; retry preserva last_error; retry sem retry_at → backoff |
| BE-T3 emissões de gatilho | ✅ completa (review ok) | `f186486`; 66/66 PASS; 4 emissões conferidas pós-mutação, payloads = contrato congelado |
| BE-T4 actor webhook_source | ✅ completa (review ok) | `852ce19`; typecheck limpo, 11/11 schema tests; 17 call sites auditados e re-verificados pelo reviewer |
| BE-T5 parser inbound | ✅ completa (review ok) | `c442f47`; 15/15 unit PASS (E.164 BR, field_map, HMAC timingSafeEqual) |
| — fix T4 (controller) | ✅ | `0a38b34`; T4 (haiku) reportou typecheck limpo FALSAMENTE (6× TS2339); controller corrigiu narrowing em 3 handlers; tsc limpo + 26/26 provado pelo controller. REGRA: controller roda typecheck após TODO implementer |
| BE-T6 rota inbound pública | ✅ completa (review ok pós-fix) | `581ce70`+`5317786`; 74 PASS + 1 skip; fix: 23505 do insert de contato re-seleciona (race não órfã lead), lookup ignora merged; reviewer confirmou zero assertions afrouxadas |
| BE-T7 avaliador de condições | ✅ completa (review ok, zero issues) | `126b938`; 11/11 unit; contrato congelado p/ engine |
| BE-T8 engine do motor | ✅ completa (review ok + fix org-filter) | `955bb9a`+`1134e01`; 80 PASS + 1 skip (6 casos novos: ordem c/ erro no meio, anti-loop 2 variantes, postpone all-or-nothing, unknown action, entity_kind mismatch); fix controller: buildContext filtra organization_id (anti-pattern #10) |
| BE-T9 ações CRUD | ✅ completa (review ok + fix título) | `f19e9d3`+`df1c627`; 88 PASS + 1 skip; catches reais: user_organizations+revoked_at, display_name; fix controller: contact.name primeiro no título |
| BE-T10 call_webhook + SSRF | ✅ completa (review adversarial ok pós-fix de segurança) | `6facb83`+`92cf410`; 15/15 unit; fixes: envelope com projeção allowlist (org_id/cpf/owner nunca saem — teste de não-contenção no body cru), redirect:"manual" (302 = falha, alvo com ZERO hits provado), IPv6 literal bloqueado. Reviewer + security-hook convergiram nos mesmos 3 achados |
| BE-T11 send_whatsapp + throttle | ✅ completa (review ok, zero fixes) | `5bc2237`; 93 PASS + 1 skip; anti-loop rastreado fim-a-fim; sent_via='ai' provado seguro; 2 tickets follow-up no ledger |
| BE-T12 APIs de gestão | ✅ completa (review ok + fix secret) | `bcf22a9`+`efbfeb1`; 12/12 schema; fix controller: secret write-only na leitura, nunca em audit; forense: cifragem §10 dropada na T1 do PLANO → ticket |
| BE-T13 verificação final | ✅ COMPLETA | Suites: unit 218/218, invariantes 93/94, typecheck limpo. **E2E REAL no banco remoto**: 0038 aplicada (Management API + token CLI do keychain; MCP OAuth quebrado), types regenerados por máquina, dev server 3011: POST público → 200 lead_id → lead com E.164/utm/custom_fields → drain 3 ticks (68 eventos, 0 falhas; 5889 sem-handler ignorados por design) → regra disparou → tags=['from-webhook-e2e'] + 1 run success com SÓ entity_kind crm_lead (duplicata do trigger filtrada ao vivo). 404 token inválido, 401 sem auth. Seed E2E desativado. |

**BACKEND 13/13 COMPLETO.** Fase UI em curso:

| UI Task | Status | Prova |
|---|---|---|
| UI-T1 sidebar + shell | ✅ | `8b738b3`+`0dbb446`; screenshot + medidas (ritmo 40px, gap 24px, h-9, Sage, Atkinson); zero console errors (fix hydration Tabs SSR); gate agent testado ao vivo |
| UI-T2 aba Receber dados | ✅ | `d34af99`+`303c46f`; fluxo leigo completo no browser: fonte criada, lead de teste REAL no banco (SQL provado), feed "há 2s"; fix: teste usa URL relativa |
| UI-T3 builder de automações | ✅ | `c26470c`+`57fe887`; regra 100% via UI rodou com controle positivo/negativo (instagram→tag, google→sem); fixes: default curado; PATH DO PLANO ERRADO utm→source_metadata corrigido |
| UI-T4 aba Atividade | ⏳ em implementação | — |
| UI-T5 kit HostGator / UI-T6 E2E+DoD | pendente | — |

Screenshots de evidência: `.superpowers/evidence/*.png`.
**NOTA DE ROLLOUT (decidir na fase UI/kit):** primeiro deploy do cron drain processa backlog histórico de tipos com handler em qualquer clone — marcar pré-existentes como done na migration do kit OU documentar o processamento tardio.
| UI T1-T6 | pendente | — |

## Última atualização

- **2026-07-17 ~17h** — T1-T3 completas com review; T4 em review. Próximo passo exato: veredito T4 → despachar T5 (parser inbound, `lib/webhooks/inbound.ts`, unit puro).

## Decisões e problemas encontrados

- **Banco remoto ainda SEM a migration 0038.** Supabase cloud (`rrydmwnpo…`) recebe via MCP (OAuth pendente — link enviado ao Rafael) ou `supabase link`+push. Obrigatório ANTES da BE-T13 (curl no dev server) e da fase UI. `database.types.ts` foi escrito à mão (typecheck ok) — regenerar por máquina quando autenticar.
- **`npm run lint` quebra no worktree** (conflito de plugin eslint pré-existente, idêntico no commit base) — não é desta feature.
- **DECISÃO DE CONTRATO (T3/T6→T8):** trigger de banco pré-existente `fn_emit_event_on_lead_change` TAMBÉM emite `lead.stage_changed` E `lead.created` com `entity_kind='lead'` (payload pobre), em paralelo às emissões dos handlers (`entity_kind='crm_lead'`). O motor (T8) DEVE filtrar por entity_kind esperado (`lead.*`→`crm_lead`, `contact.*`→`contact`, `message.received`→`message`) e skip no resto — senão TODA regra de lead dispara 2x. Ticket futuro: decidir se o trigger duplicado morre.
- **Desvios de schema validados na T6:** `webhook_events_log.provider` tem CHECK que rejeita 'lead_capture' → rota usa `'generic'` (feed da UI filtra por webhook_path_token, não por provider — sem impacto); `contacts.email_normalized` é generated column (não insertar). Telefone que falha E.164 vai cru em `source_metadata.raw_phone`.
- T3 adicionou dummy Supabase env em `vitest.db.config.ts` (test.env) — teste importa handlers que puxam `lib/env`.
- Minors acumulados p/ review final estão no ledger `.superpowers/sdd/progress.md`.
- Stash stack compartilhado: conferido limpo. Regra: nunca `git stash` bare (worktrees compartilham o stack com o gov-loop).
