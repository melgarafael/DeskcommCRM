---
type: threat-model
project: SonghaiCRM
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code) — leitura de rotas, guards, proxy.ts e lib/env.ts
confidence: média-alta (superfície e guards são CONFIRMADO por leitura de código; explorabilidade é INFERIDO — nada foi testado contra instância viva)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)
---

# Threat model — SonghaiCRM self-host

Complementa [`SECURITY.md`](../SECURITY.md), que é política de *reporte*. Este documento é
o inventário da **superfície de ataque real**: o que fica exposto quando alguém sobe o
SonghaiCRM numa VPS com IP público.

**Modelo de implantação que muda tudo:** o produto é self-host open-source. O atacante
tem o **código-fonte completo** — conhece cada rota, cada nome de env var, cada fallback.
Segurança por obscuridade vale zero aqui. E o operador é tipicamente uma PME sem equipe
de segurança: um default inseguro não vai ser corrigido por ele.

**Nada aqui foi explorado.** Nenhum ataque foi executado, nenhuma instância foi tocada.
São conclusões de leitura de código.

---

## 1. Superfície exposta sem sessão

`lib/auth/public-paths.ts` define o que passa sem checagem de auth no `proxy.ts`
(middleware do Next 16). CONFIRMADO:

| Path | Guard próprio dentro da rota | Rate limit |
|---|---|---|
| `/`, `/login`, `/signup`, `/auth/confirm` | Supabase Auth | ❌ |
| `/team/accept-invite/:token` | HMAC-SHA256 + `timingSafeEqual` (`lib/auth/invite-token.ts`) | ❌ |
| `/api/v1/health` | nenhum (por design) | ❌ |
| `/api/v1/webhooks/waha/*` | HMAC-SHA512 + `timingSafeEqual` (`lib/waha/ingest.ts`) | ❌ |
| `/api/v1/webhooks/in/:token` | path token + assinatura opcional | ✅ 60/min por token |
| `/api/v1/cron/*` (9 rotas) | `Bearer INTERNAL_CRON_SECRET\|INTERNAL_SECRET`, **fail-closed** | ❌ |
| `/api/internal/*` | `x-internal-secret` ou `Bearer INTERNAL_SECRET`, comparação em tempo constante | ❌ |
| `/api/mcp` | `Bearer tok_...` validado contra `api_tokens` (hash SHA256) | ❌ |
| `/account-suspended`, `/403`, `/404`, `/500`, `/503`, `/admin/forbidden` | — | ❌ |

**Leitura:** a autenticação de cada superfície está bem construída — HMAC com
`timingSafeEqual` em 6 módulos distintos, crons fail-closed, bearer só via header
(nunca query string), plaintext do token nunca persistido. O problema **não é o guard;
é a ausência de limite de tentativas na frente dele.**

---

## 2. Riscos por ordem de exploração

### T1 — Brute force e enumeração sem custo 🔴 CONFIRMADO (ausência), INFERIDO (impacto)

> ## ⚠️ ENDEREÇADO DEPOIS DESTA AUDITORIA — releia antes de agir sobre T1
>
> Este documento foi auditado contra `789dfa6` (2026-07-27), e o front-matter diz isso. O
> corpo, porém, fala no **presente** — e um leitor decide pelo corpo. Medido em 2026-08-14 na
> `main`:
>
> - **`lib/auth/rate-limit.ts` existe** e foi escrito para fechar exatamente este risco: o
>   cabeçalho cita a issue #64 e nomeia login, signup, recuperação de senha e aceite de convite.
> - É usado nos **quatro** pontos que o texto abaixo diz estarem descobertos:
>   `app/actions/auth/signInWithPassword.ts`, `signUp.ts`, `requestPasswordReset.ts` e
>   `app/team/accept-invite/[token]/page.tsx`.
> - Limites em vigor (`AUTH_LIMITS`): `login` 5 por identificador / 300 s, `signup` 20 por IP /
>   3600 s, `reset` 30 IP e 3 id / 3600 s, `invite_accept` 60 por IP / 3600 s.
> - **A sub-afirmação "não existe lockout por conta" sobrevive à letra e morre no espírito.** A
>   sonda que o texto usa (`grep lockout|failed_attempts`) devolve **zero** — ainda hoje. Mas
>   `rate-limit.ts:158/165` conta falha de login **por conta**, na chave
>   `auth:login_fail:id:<hash>`. A sonda é cega para o mecanismo que existe, e é o exemplo mais
>   limpo deste documento de por que ausência de sonda não é ausência de defesa.
>
> **O veredito 🔴 NÃO foi rebaixado aqui, de propósito.** Rebaixar risco de segurança pede
> reauditoria com teste contra instância viva, que é o que o próprio `confidence` do
> front-matter diz nunca ter havido. O que esta nota faz é corrigir os **fatos** e marcar o T1
> como devendo reauditoria — não decidir por ela.

`checkRateLimit` existe (`lib/ai/dispatcher/rate-limit.ts`) e é chamado em **2** pontos
do código: `/api/v1/webhooks/in/:token` e o dispatcher de IA. Nada mais.

Não há **nenhum** limite de tentativa em:

- **`/login`** — e não existe lockout por conta: `grep` por `lockout` / `failed_attempts`
  não retorna nada. Senha fraca de operador é atacável na velocidade da rede.
- **`/signup`** — criação de organização em massa; num self-host multi-tenant isso é
  exaustão de recurso (e de cota de IA, se as chaves forem da instância).
- **`/team/accept-invite/:token`** — o HMAC é forte, mas sem limite o atacante pode
  sondar indefinidamente e sem custo, e sem gerar sinal de alerta.
- **Os 9 crons e `/api/internal/*`** — o secret é forte e a comparação é em tempo
  constante, mas nada limita o volume de tentativas.
- **`/api/mcp`** — enumeração de bearer token.

**Mitigação recomendada:** aplicar `checkRateLimit` por prefixo no `proxy.ts` (uma passada
cobre todo o surface público de uma vez) + limite por identificador nas rotas de auth
(por e-mail no login, não só por IP — IP rotativo é trivial). Custo baixo, a infra já existe.

### T2 — Fallback in-memory do rate limit anula o limite que existe 🟠 CONFIRMADO

`lib/ai/dispatcher/rate-limit.ts:23` — sem `UPSTASH_REDIS_REST_URL`/`_TOKEN` o contador cai
para um `Map` em memória do processo. Consequências:

- É o estado **normal de um primeiro deploy** (Upstash é serviço externo; `lib/env.ts:69`
  trata as duas vars como opcionais em dev e obrigatórias só em produção).
- Multi-instância ou multi-worker ⇒ limite por processo, não por tenant.
- O único sinal é um `logger.warn` uma vez por processo. Um operador de PME não vai ver.

O stack de produção do kit inclui `serverless-redis-http` + Redis local (visto em
`docker-compose.prod.yml`), o que resolve — **A CONFIRMAR** se o `install.sh` garante que
essas duas vars ficam populadas em toda instalação.

### T3 — 89 handlers com service role, sem gate de escrita 🟠 CONFIRMADO (contagem)

`createAdminClient` (service role, **bypassa RLS**) é importado em **89 dos 169** route
handlers de `app/api/**` (dos quais 166 estão sob `/api/v1/`). A regra da doutrina —
"filtre `organization_id` manualmente, resolvido de fonte
confiável, nunca do body" — é aplicada por revisão humana. Não há lint rule nem teste que
falhe quando um handler *novo* esquece o filtro.

Este é o **pior modo de falha do produto**: vazamento cross-tenant. Duas mitigações reais
existem: as amostras que li (`admin/tenants`, `webhooks/in/:token`, `team/:user_id`) seguem o
padrão corretamente, e os **56 arquivos de invariante em `tests/invariants/` rodam no CI**
(job `invariants` → `pnpm test:db`), cobrindo isolamento cross-tenant de verdade. O
guard-rail existe **e está ligado** — rebaixei de 🔴 para 🟠 por isso.

**Lacuna residual:** os invariantes provam que os caminhos cobertos isolam; não impedem que
um handler novo nasça sem filtro e sem invariante correspondente.

**Mitigação recomendada:** regra de ESLint custom (ou teste que varre o diff) que falhe
quando um arquivo importa `lib/supabase/admin` sem referenciar `organization_id`. Barato,
determinístico, e transforma disciplina em gate.

### T4 — Secret de convite com fallback conhecido 🟠 CONFIRMADO no código, mitigado na prática

`lib/auth/invite-token.ts:16`:

```
INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback"
```

Se a cadeia chegar em `"dev-fallback"`, qualquer pessoa com o repo público forja um token
de convite válido — payload inclui `organization_id` e `role`, ou seja: **admin em qualquer
org**.

**Mitigação existente:** `INTERNAL_SECRET` é `required()` em `lib/env.ts:47`, que em
`NODE_ENV=production` **derruba o boot** se estiver vazio. Então numa instância de produção
que subiu, o fallback é inalcançável (INFERIDO — depende de o self-host rodar com
`NODE_ENV=production`, o que é o esperado com `next start`).

**Residual:** (a) em dev a validação afrouxa e a var vira `""` — e string vazia é falsy,
então cai no `"dev-fallback"`; (b) `invite-token.ts` lê `process.env` **cru**, contornando
o Zod, então não herda garantia nenhuma; (c) `INVITE_TOKEN_SECRET` não existe em
`lib/env.ts` nem em `.env.example`, só em docs de épico.
Já está rastreado pelo projeto como risco **M4** em `docs/testing/user-journey-map.md` —
crédito onde é devido.

**Mitigação recomendada:** eliminar o literal. Falhar alto (`throw`) quando nenhum secret
existe, em vez de degradar para um valor público.

### T5 — Secrets ausentes do `.env.example` 🟠 CONFIRMADO

`IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY` estão em
`lib/env.ts` e **não** no template. O operador não sabe que precisa gerá-los.

Como são `required()` (obrigatórios só em produção), o efeito mais provável é falha de boot
com mensagem clara — que é o comportamento seguro. O risco real é indireto: instalação
frustrada, operador colando valor fraco ("123456") só para o app subir, ou reaproveitando
o mesmo valor em todos.

### T6 — SSRF em webhook de saída 🟢 MITIGADO — CONFIRMADO

`lib/automation/outbound-url.ts` + `outbound-url.test.ts` + `lib/automation/actions/call-webhook.ts`
implementam guard de URL de saída, e existe E2E dedicado
(`tests/e2e/vps-webhook-outbound-ssrf.spec.ts`). É a defesa mais bem feita do repo.

**Ressalva:** esse E2E **não roda no CI** — e é a única prova automatizada do guard.
`outbound-url.test.ts` é unitário e roda, o que cobre a lógica de decisão; o que não roda é a
prova de que o egress real está barrado ponta a ponta. Uma regressão na integração passa.

### T7 — Sem varredura de secret no histórico git 🟡 CONFIRMADO

Sem gitleaks/trufflehog no CI, sem pre-commit hook (`.husky` e `.pre-commit-config.yaml`
ausentes). `.gitignore` cobre `.env*` corretamente, e essa é a única camada.

Agravante específico deste repo: a doutrina de QA visual **incentiva commitar evidência
visual**, e há **116 PNGs rastreados** (85 em `evidence/` contando subpastas, 18 em
`docs/evidence/`, 13 em `loop/checkpoints/evidence/`). Screenshot de tela autenticada pode conter telefone, nome de
cliente ou token em URL — e várias evidências são explicitamente descritas nos HANDOFFs como
tiradas em **conta e conversa reais de WhatsApp**. Num repo público, é irreversível.

Não é argumento contra a doutrina de evidência visual, que é boa. É argumento para um passo
de revisão de PII antes do commit — e `gitleaks` não pega isso, porque não lê imagem.

### T8 — Onde a auditoria é cega ⚪ NÃO IDENTIFICADO

Não avaliado por falta de execução/instância:

- Se as políticas RLS **realmente** isolam (os invariantes existem para provar; não foram rodados).
- Postura do container WAHA — `docker-compose.prod.yml` comenta "Core por default, dashboard
  off", mas exposição de porta e rede não foram verificadas contra instância viva.
- Config do Caddy (`Caddyfile`) — TLS, headers de segurança, HSTS.
- Se `next.config.ts` define CSP / security headers.
- Storage: se o bucket `whatsapp-media` está privado de fato e se a expiração das signed
  URLs é adequada.
- Storage, e este é MEDIDO e DECLARADO em vez de "não avaliado": `brand-logos` (migration
  0158) é o **único bucket público** do repositório — os outros quatro nascem
  `public = false`. A exceção existe porque o logo é renderizado num `<img>` da tela de
  **login**, servida a quem não tem sessão, e URL assinada **vence**: a marca da instalação
  sumiria da fachada sozinha no dia do vencimento. O que a contém, e o que
  `tests/invariants/marca-logo.test.ts` reprova quando deixa de valer: bucket **exclusivo**
  de logo (nada de conversa, export ou base de conhecimento mora nele, então "público" não
  vaza histórico de cliente), **zero policy** em `storage.objects` citando o bucket
  (`public = true` abre a LEITURA pelo endpoint `/object/public/...`; INSERT e DELETE
  continuam só no `service_role`), caminho **não-enumerável** (`<prefixo>/<uuid v4>.<ext>`)
  e teto de 512 KB. O que entra é decidido pelos **bytes** (`lib/branding/logo-arquivo.ts`),
  nunca pelo `Content-Type` — `allowed_mime_types` do bucket e `file.type` na rota leem a
  mesma string que quem sobe escolhe. **SVG é banido**: este repo não define CSP (ver o item
  acima sobre `next.config.ts`), e SVG navegado direto do endereço da imagem executa script.
  O que NÃO está coberto: um logo subido é **público para sempre até ser trocado** — quem
  subir por engano uma arte confidencial precisa removê-la pela tela, e a URL antiga deixa
  de existir junto com o arquivo (a rota apaga o anterior na troca).
- Escopo do service role key no Supabase e rotação de chaves.
- Efetividade do `beforeSend` do Sentry contra PII real.

---

## 3. Sumário de prioridade

| # | Risco | Sev | Custo do fix |
|---|---|---|---|
| T1 | Sem rate limit em login/signup/convite/crons/MCP | 🔴 | baixo — infra já existe |
| T2 | Rate limit degrada silenciosamente para memória | 🟠 | baixo |
| T3 | Service role sem gate de escrita para handler novo | 🟠 | médio (lint rule) — invariantes já cobrem em CI |
| T4 | `"dev-fallback"` como secret de convite | 🟠 | trivial |
| T5 | 3 secrets fora do `.env.example` | 🟠 | trivial |
| T7 | Sem scan de secret no CI + 116 PNGs de evidência sem revisão de PII | 🟡 | baixo |
| T6 | Guard de SSRF existe; o E2E que o prova não roda no CI | 🟢 | baixo |

**Conclusão honesta:** os *mecanismos* de segurança deste projeto são acima da média para
um CRM open-source — HMAC em tempo constante em toda borda, fail-closed nos crons, hash de
bearer, RLS com helper central, guard de SSRF testado, LGPD implementada de verdade,
`beforeSend` higienizando PII, e **56 arquivos de invariante de isolamento rodando em CI**.

O que falta é estreito e específico: **limite de tentativa na frente dos guards**. Não há
falha de desenho aqui; há uma camada ausente, e ela é a mais barata de todas as que já foram
construídas.

---

## 4. Perguntas para o responsável

1. O `install.sh` garante `UPSTASH_REDIS_REST_URL`/`_TOKEN` populados em toda instalação?
   (decide a severidade de T2)
2. Alguma instância de produção já rodou sem `INTERNAL_SECRET` definido? (decide se T4 já
   foi exposto em campo)
3. Os 116 PNGs de evidência foram revisados quanto a PII antes do commit? Vários são
   descritos como tirados em conta e conversa reais de WhatsApp.
4. Existe branch protection exigindo os dois checks do CI verdes no merge? (não é visível
   no checkout)
5. Há intenção de pedir pentest externo antes de divulgar a v1.0.0 mais amplamente?
