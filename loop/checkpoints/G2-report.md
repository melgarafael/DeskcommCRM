# Checkpoint G2 — RBAC aplicado (API + banco + UI + e2e) — 2026-07-16
Status: COMPLETO

## 1. Entregue nesta fase

| Feature | Título | Commit | Verificação |
|---|---|---|---|
| G2-01 | Matriz role×endpoint aplicada server-side em /api/v1 | 4e90ad4 | gov-verifier PASS 2026-07-16 (2ª rodada; 1 finding reparado) |
| G2-02 | Papel de membro editável pós-convite (API + UI + audit) | b157aee | gov-verifier PASS 2026-07-16 (1ª rodada) |
| G2-03 | RLS por role nas tabelas de configuração + invariantes verdes | f3954ab | gov-verifier PASS 2026-07-16 (1ª rodada) |
| G2-04 | E2E de papéis (Playwright) | da453e4 | gov-verifier PASS 2026-07-16 (1ª rodada) |

## 2. Evidências (prova, não afirmação) — gates da fase G2

**Gate "matriz role×endpoint server-side (não só RLS, não só UI)"** — helper único
`lib/auth/require-role.ts` (getUser + fn_user_role_in_org + fail() 403 padronizado
+ audit `authz.denied`), aplicado a ~47 rotas de /api/v1 conforme spec 13 §4.
Prova mecânica: `tests/unit/rbac-matrix.test.ts` (12 testes, 403 para role
insuficiente + 200 para role mínimo por grupo de rota) + `lib/auth/require-role.test.ts`
(9 testes). Suíte unit da fase: **123/123 verdes**.

**Gate "papel de membro editável pós-convite, com audit"** — PATCH canônico
`/api/v1/team/[user_id]` (lógica única em `_shared.ts`, `/role` mantido como alias),
guard de último admin (409, provado ao vivo), audit `team.role_changed` com
old/new_role (linha real observada em api_audit_log no dev). UI: seletor inline na
página Equipe (admin only, nunca na própria linha), otimista com rollback + toast.
Screenshot: `loop/checkpoints/evidence/G2/G2-02-team-role-selector.png`.

**Gate "invariantes de RBAC de G1 todos verdes (flip dos test.fails)"** — os 2
`it.fails` GAP(G2) de `tests/invariants/gov-1-rbac.test.ts` flipados para testes
normais na G2-03 (commit f3954ab com `DESKCOMM_GOV_INVARIANTS_EDIT=1` citando o
flip) após a migration 0030 (tripla completa: migrations/ + apêndice baseline +
MANIFEST; `check-migration-triple.sh` exit 0; NNNN 0030 inédito nas 10 branches).
`pnpm test:db`: install (ON_ERROR_STOP=1) + update (re-apply) verdes; **35/35
invariantes verdes no Postgres descartável pós-update**, incluindo o novo
`gov-1-rbac-config-write.test.ts` (manager escreve config, agent não; viewer
read-only em conversations; SELECTs preservados byte-idênticos — leitura NÃO foi
estreitada, escopo own é G4-01).

**Gate "E2E de papéis passa"** — `tests/e2e/rbac-roles.spec.ts`: agent →
api-tokens/billing → 403 renderizado; admin entra com **login MFA TOTP real**
(challenge em /login/mfa, código gerado de `tests/e2e/utils/totp.ts`, RFC 6238,
zero dependência nova); agent vê inbox e kanban; viewer → POST /api/v1/messages →
403 `forbidden_role`. Run do verifier: **12 passed / 1 failed (32.4s)** — o único
vermelho é `error-pages.spec.ts` "/500", **pré-existente** (rota app/500 nunca
existiu; vem do EPIC-12, commit 5d0cdb5, ancestral de main; independência do diff
provada em 3 eixos). Axe (serious/critical) zerado em /403, api-tokens, billing,
inbox e kanban, com 1 exclusão documentada (tablist do InboxFilters, violação
pré-existente). Screenshot: `evidence/G2/G2-04-agent-billing-403.png`.

## 3. Pendências (cópia auditável da inbox operacional)

- **INB-03 (open, needs_human, da G2-01)** — follow-ups não-vetantes: (1)
  `onboarding/whatsapp/session` POST cria channel_session sem gate de role (a rota
  equivalente channel-sessions exige admin) — gate admin aqui também? Recomendação:
  sim, por consistência. (2) `leads/bulk action=assign` tem piso agent hoje; o
  endpoint batch da G3-04 já nasce ≥manager — nota pra G3-04 não esquecer.
- **INB-04 (open, needs_human, da G2-02)** — race no guard de último admin
  (check-then-write sem lock, pré-existente do EPIC-09): 2 PATCHes simultâneos
  podem rebaixar os 2 últimos admins. (A) fechar com constraint/trigger
  (mini-feature, migration tripla) · (B) aceitar o risco. Recomendação: A.
- **INB-05 (open, proposal, da G2-03)** — spec 13 §4 nota 8 prevê `api_audit_log`
  SELECT manager+ "aplicada em G2", mas nenhuma feature G2 cobre; segue admin-only.
  (A) manter admin-only e corrigir a nota da spec · (B) mini-feature nova.
  Recomendação: A.

## 4. Riscos observados na construção

- `error-pages.spec.ts` "/500" é vermelho crônico (rota nunca existiu) — merece
  forward-fix fora do épico pra suíte e2e voltar a ser binária.
- Violação axe pré-existente no tablist do InboxFilters (aria-controls para
  painel não renderizado) — excluída de forma documentada no spec novo; corrigir
  quando G4-02 tocar o inbox.
- `member.role_changed` fica no union de audit sem emissor (doutrina append-only;
  histórico antigo permanece válido) — cosmético, sem ação.
- O gate admin-only de `billing/page.tsx` não existia (agent renderizava billing);
  adicionado na G2-04 como desvio mínimo aprovado pelo verifier — sinal de que
  outras páginas podem ter gates de UI faltando mesmo com a API fechada (a G2-01
  fechou o server-side; auditoria de páginas não era acceptance de nenhuma feature).
- Race do último admin (INB-04) documentada acima.

## 5. O que a PRÓXIMA fase (G3) precisa

- Aprovação deste checkpoint (`loop/checkpoints/G2.approved`).
- Decisões do dono nos INB-03/04/05 (nenhuma bloqueia G3-01, mas INB-03.2 toca a
  G3-04 e INB-04 pode virar mini-feature da G3).
- Nada de infra nova: G3-01 (eventos de atribuição) usa o harness test:db/invariants
  já operante; decisões de produto G1-06 (transferência imediata, reuso do role
  agent) já transcritas na spec 13.

## 6. Custo da fase

- 4 sessões do loop (started 21:53, 22:32, 22:53, 23:09 — sessions.log), todas
  fechadas com PASS na mesma noite de 2026-07-16 (~1h40 de parede no total).
- 1 rodada de reparo (G2-01); zero features bloqueadas; teto diário atingido
  exatamente na última sessão (12/12).
