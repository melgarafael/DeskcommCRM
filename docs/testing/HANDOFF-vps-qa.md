# HANDOFF — QA da experiência do usuário em VPS (open-source)

> ⚠️ **INSTRUÇÃO PERMANENTE:** trabalho de QA de jornada é regido pela doutrina
> "QA Visual com Recursos Reais" no `CLAUDE.md`. Prova só conta pela tela, em
> ambiente fresco estilo VPS. Atualize este arquivo a cada avanço.

## Objetivo

Mapear e estressar TODAS as ações do usuário numa instalação VPS fresca —
onboarding, WhatsApp, agentes de IA, CRM/pipelines, convites/atendentes,
webhooks (receber + automações) — pelo frontend, com recursos reais, corrigindo
os bugs achados na causa raiz.

## Ambiente montado (reproduzível)

- **Banco:** Supabase local **pg17** (`config.toml major_version = 17`) do
  `baseline.sql`; extensões `vector/pg_trgm/citext/uuid-ossp/pgcrypto` antes.
- **Primeiro usuário:** `scripts/bootstrap-owner.ts` (como o `install.sh`):
  `dono@qa.local` / `QaVps!2026#Dono`, org "Loja QA VPS".
- **Deps:** WAHA Core local (`deskcomm-waha`, :3030), Redis + serverless-redis-http
  (`qa-redis`/`qa-srh`, :8079), cron drain via endpoint.
- **App:** `next build` + `next start` na :3001, `NODE_ENV=production`.
- **Realismo de VPS:** `RESEND_API_KEY` VAZIO de propósito (primeiro deploy não
  tem email) — é onde apareceram bugs de primeira impressão.
- **Worktree:** `~/DeskcommCRM-qa` (branch `qa/vps-experience`), `node_modules`
  REAL (não symlink), FORA de `/tmp` (foi limpo no meio da sessão 1x).
- **Config de teste local (NÃO commitar):** `enable_signup = true` no config.toml
  local libera o password-grant do GoTrue local para o seed; em produção o login
  do dono bootstrapado funciona normal.

## Estado atual (2026-07-20)

### Jornadas provadas

| Jornada | Cobertura | Prova |
|---|---|---|
| **J1 Onboarding** (dono, fresco) | ✅ 11/11 | `tests/e2e/vps-fresh-onboarding.spec.ts`; screenshots em `.superpowers/evidence/vps-qa/`. Achou e corrigiu 3 bugs (abaixo). Commit `35caf6f`. |
| **J6.8 Webhook outbound (anti-SSRF)** | ✅ 1/1 | `tests/e2e/vps-webhook-outbound-ssrf.spec.ts`; receiver HTTP real, zero hits, run falha com segurança. Commit `<este>`. |
| J5 Convites/atendentes | ✅ verde isolado | `invite-lifecycle` (9), `rbac-roles` (4), `inbox-scope`, `queue-assign` — pré-existentes, passam isolados. |
| J6 Webhooks inbound + automação tag | ✅ verde isolado | `webhooks.spec.ts` (fluxo completo). |
| J4 Kanban owner filter | ✅ verde isolado | `kanban-owner-filter.spec.ts`. |

### Bugs de produto corrigidos (causa raiz + re-teste verde)

1. **Onboarding — pular WhatsApp travava o wizard.** `skipWhatsapp`/`markWhatsappConfigured`
   redirecionavam hardcoded pro `connect-nuvemshop`, step OCULTO quando
   `NUVEMSHOP_ENABLED=false` (padrão de VPS). Fix: redirect pro roteador `/onboarding`.
   (`app/actions/onboarding/skipWhatsapp.ts`)
2. **Onboarding — convite sem Resend mentia sucesso.** `sendOnboardingInvites`
   redirecionava em silêncio; o admin achava que convidou mas nada saiu. Fix:
   retorna `undelivered[]` com `accept_url`; UI mostra links copiáveis.
   (`sendOnboardingInvites.ts` + `invite-team/_form.tsx`)
3. **MFA — usuário perdia os recovery codes (CRÍTICO).** `confirmMfaEnroll` é
   Server Action; a revalidação da rota desmontava o `MfaEnrollGate` assim que o
   fator virava `verified`, destruindo a tela de códigos de recuperação antes do
   admin salvá-los. Fix: gate envolve o shell e latcha a decisão client-side.
   (`components/auth/MfaEnrollGate.tsx` + `app/app/layout.tsx`)

### Bug de DX corrigido

- **`config.toml major_version=15` vs baseline pg17.** Baseline usa `GRANT MAINTAIN`
  (pg17+); contribuidor rodando `supabase start` pegava pg15 e o baseline quebrava.
  Fix: `major_version = 17`.

## Achados pendentes (mapa completo em `docs/testing/user-journey-map.md`)

- **M2/M10** — trilha manual do `docs/deploy-selfhost/README.md` não configura o
  cron do drain → automações morrem em silêncio numa VPS que não usou o kit.
- **M3** — README self-host aponta repo/imagem `deskcommcrm/*`; kit usa `melgarafael/*`.
- **M4** — `INVITE_TOKEN_SECRET` ausente → fallback `"dev-fallback"` → convite forjável.
- **M5** — AI Gateway key ausente → bot mudo sem feedback na UI.
- **M6** — Knowledge sources: upload de FAQ/política é stub "Em breve".
- Rate limit do GoTrue morde sob carga de muitos logins (artefato de suíte em lote,
  não bug de produto — rodar jornadas em lotes menores).

## Próximos passos (ordem)

1. **[precisa do Rafael]** WhatsApp real: escanear QR de número de teste → provar
   J2.3/J2.4 (conexão WORKING) e J3.4–J3.9 (IA respondendo mensagens de verdade).
2. J4 restante: criar lead pela UI, drag-and-drop, ganhar/perder (specs novos).
3. J7 exploração: varrer todas as rotas como admin e agent, caçar tela quebrada.
4. Endereçar M2/M3/M4 (docs + segurança do convite) se entrarem no escopo.
