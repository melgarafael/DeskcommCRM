# PR 2 — Planos e limites — Plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa por tarefa. Passos com checkbox (`- [ ]`).

**Goal:** o dono de uma instalação cria planos, atribui um plano a cada empresa e trava por plano as pessoas, os números de mensagem conectados e o gasto de IA — tudo desligado por padrão, atrás da chave `MODULO_COBRANCA`, sem mudar nada para quem não a liga.

**Architecture:** duas tabelas novas no núcleo (`cobranca_planos`, da instalação; `cobranca_assinaturas`, uma linha por empresa), três funções de leitura (`fn_cobranca_ligada`, `fn_limite_do_plano`, `fn_cobranca_liberar_suspensoes`) e três gatilhos (assentos, canais, teste grátis na criação). Empresa sem linha em `cobranca_assinaturas` é isenta: `fn_limite_do_plano` devolve nulo e nenhum limite vale. A chave nasce travada na tela (`MODULOS_AINDA_NAO_LIGAVEIS`) até o PR 3a; as provas ligam por fixture. Os provedores de pagamento (Stripe, Asaas) **não** entram aqui.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6 estrito, Supabase (Postgres 15/17, PostgREST, RLS), Zod 4, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md` (§1.2, §2.2, §2.3, §2.6, §2.7, §2.8, §5, §7g, §7h, §9, §10, §11 PR 2, §12, §13, §14 PR 2, §15) e `docs/adr/0004-cobranca-do-revendedor.md`. Issue de reivindicação: #2108.

**Base medida:** `origin/main` = `efed1d574` (02/10/2026), que já contém o PR 1 (#1987, migration 0501). Toda referência `arquivo:linha` abaixo foi medida nesse SHA e **envelhece**: o conteúdo citado é a autoridade. O `baseline.sql` passou de 45 mil linhas; a spec cita linhas de quando ele era menor, e nenhuma delas vale mais. Onde este plano diz "a última definição", é a última do arquivo (`rfind`), nunca a primeira (CLAUDE.md, migrations, item 10).

---

## Global Constraints

- Worktree novo por sub-PR em `.claude/worktrees/<nome>`, criado de `origin/main` (nunca do `main` do fork), com `node_modules` real (`pnpm install --frozen-lockfile`), nunca symlink. Branch nasce atualizada: `git fetch origin && git merge origin/main`. Nunca `reset --hard`, `--force` nem `--no-verify`.
- **Veredito vem do CI**, não da máquina local: empurre a branch para o fork, abra PR interno no fork e leia os checks. `pnpm test:db` só roda onde houver Docker. Onde um passo diz "rode X", entenda "rode X onde houver ambiente, e confirme no CI". O fork precisa da tag `v1.63.0` copiada do `origin` para os `invariants` rodarem.
- Migration: `supabase/migrations/<timestamp>_<NNNN>_cobranca_planos_e_assinaturas.sql`. `NNNN` é **o próximo livre no merge**: a `main` vai até `0501` e há migrations em voo até `0507` (medido com `gh pr view <n> --json files` em todo PR aberto; vários PRs disputam `0502`). Provisório: `0508`. Rode `pnpm checar:colisao-de-migration` antes de abrir o PR e de novo antes do merge. Renumerar = trocar em arquivo, apêndice do baseline, MANIFEST e invariantes.
- Migration idempotente (`create ... if not exists`, `create or replace function`, `drop trigger if exists` + `create`, `drop column if exists`), sem `BEGIN`/`COMMIT`, sem tabela temporária.
- Apêndice no `supabase/baseline.sql`, rotulado `-- ---- cobrança: planos e assinaturas (migration NNNN) ----`, **acima** do cabeçalho `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----` (cerca: `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`: nenhuma `create function` nem `grant ... to anon` depois dele). As duas tabelas e os gatilhos também entram acima dele, para vir antes das chamadas finais de `fn_proteger_tabelas_de_organizacao` e `fn_aplicar_travas_de_suporte` (hoje no fim do arquivo).
- Toda função nova em `public`: `revoke execute on function public.fn_x(...) from public, anon, authenticated;` + `grant execute ... to service_role;` (a função de gatilho: só o revoke). As **duas** origens de `EXECUTE` (CLAUDE.md, migrations, item 9). Vigiado por `tests/invariants/hardening-definer-varredura.test.ts`.
- Uma linha no fim da tabela "Applied" de `supabase/migrations/MANIFEST.md` (`merge=union`: conferir duplicata depois de cada merge).
- `lib/database.types.ts` é editado à mão, no formato gerado (não há script).
- Multi-tenancy: `cobranca_assinaturas` leva `organization_id uuid not null references organizations(id) on delete cascade` e RLS; `cobranca_planos` é da instalação (sem `organization_id`) e **sem nenhuma policy** (molde `platform_config`). Handler com service role filtra `organization_id` de fonte confiável (sessão ou path), nunca do body.
- Escrita do dono: `requirePlatformAdminEscrita()` (`lib/auth/requirePlatformAdmin.ts`, entrou no PR 1) nas rotas; `escritaDeAdminOuRecusa()` (`lib/auth/escritaDeAdminOuRecusa.ts`) nas server actions. Toda rota de cobrança responde **404** com a chave desligada.
- Todo handler mutante de `app/api/v1` declara `requireSupportWrite(` **antes do efeito** (CLAUDE.md, suporte temporário; cerca `tests/unit/suporte-cobertura-de-efeitos.test.ts`).
- Audit: toda mutação bem-sucedida emite uma linha de `audit()`; ações novas entram no fim de `lib/audit/actions.ts`.
- Todo texto novo de tela tem entrada `es` (e `zh-CN` onde o painel exige) em `lib/i18n/dicionario.ts` no mesmo PR; antes de colar, `grep -c` da chave = `0` (chave duplicada é `TS1117`, só na árvore mesclada).
- Sem `console.log`, sem SDK de provedor, sem env var nova (esta entrega não adiciona nenhuma).
- Fragmentos `.changes/`: PR 2a, 2c, 2d → `impacto: nada_mudou`, `secao: alterado`; PR 2b, 2e → `impacto: nada_mudou`, `secao: alterado` (a capacidade existe mas não pode ser ligada pela tela). Texto na voz de quem opera, crédito `@paulolimajr77`.
- Commits em conventional commits, pt-br, última linha `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Sabotagem só depois do commit; ao restaurar, confira a PRESENÇA do conserto com `grep -c`.
- Teste isolado: `pnpm exec vitest run <arquivo>`; invariantes só por `pnpm test:db [<arquivo>]`; a suíte é `pnpm test:unit` **sem caminho**, com o log redirecionado; o rodapé e o exit code são a autoridade.

## Review Focus

Os modos de falha mais prováveis que a spec implica e nenhuma tarefa dela exercita, e onde cada um é pego:

1. **O gatilho de assentos, como a spec o escreve, não recusa ninguém.** A spec manda um gatilho `security definer` checar `current_user in ('authenticated','anon')` para impedir membro provisório pelo PostgREST. Dentro de função `security definer`, `current_user` é o dono da função, não quem chamou: o teste nunca dispararia. O gatilho que já existe (`fn_organizacao_estado_so_pelo_servidor`, PR 1) é `security invoker` exatamente por isso. **Task 5** separa em dois gatilhos (um `invoker` só para o provisório, um `definer` só para a contagem); o caso `⭐ provisório pelo PostgREST → 42501` do invariante prova.
2. **Empresa com plano que nunca teve limite de assento e o `UPDATE` de reativação.** `user_organizations` já tem membros além do teto quando o dono atribui um plano pequeno. O gatilho só conta quando uma linha **passa a ocupar vaga** (insert ativo, `revoked_at` volta a nulo, deixa de ser provisória, muda de organização); nada derruba quem já está. **Task 5** tem o caso "5 membros, plano de 3: nenhum cai, o 6º é recusado, reativar o 5º revogado é recusado".
3. **`fn_limite_do_plano` com a chave desligada ou sem linha precisa ser nulo, sempre, sem erro.** Qualquer exceção ali vira 500 em convite, conexão de número e criação de empresa em **toda** instalação, inclusive nas que nunca ligaram a cobrança. **Task 3** testa os três nulos (chave ausente, `desligado`, sem assinatura) e que um recurso desconhecido lança `22023` mesmo com a chave desligada.
4. **Redefinir `fn_suspender_organizacao`/`fn_reativar_organizacao` copiando a definição errada reverte o PR 1.** O baseline já registrou isso para `emit_event`. Hoje existe **uma** definição de cada (as do PR 1, migration 0501; medido com `grep -c`); se outro PR mexer nelas antes do merge, a cópia daqui fica velha. **Task 4** extrai a última definição por script, aplica só as duas mudanças da spec e prova por invariante que os casos do PR 1 (`org-suspensa.test.ts`) continuam verdes.
5. **Soltar a trava de `provisional_until_handover` quebra a criação de empresa pelo dono.** `fn_create_tenant_with_owner` é a única que grava essa coluna, rodando como `service_role`/`definer`; o gatilho `invoker` não pode barrá-la. **Task 6** tem o caso "criar tenant para outra pessoa (provisório) continua funcionando como `service_role`, e como `authenticated` é 42501".

## Divergências medidas da spec

| # | Spec diz | Código de hoje (`efed1d574`) | Decisão do plano |
|---|---|---|---|
| D1 | Gatilho de assentos `security definer` checa `current_user` | `current_user` em função `definer` é o dono | Dois gatilhos (Review Focus 1) |
| D2 | `AdminSidebar` ganha `modulo?` e o layout passa `modulosLigados` | `components/admin/AdminSidebar.tsx` não tem nenhum dos dois (`NavItem` sem `modulo`) | Task 13 cria os dois |
| D3 | `MODULOS_AINDA_NAO_LIGAVEIS` ganha `cobranca` | hoje é `[]` (`lib/instalacao/modulos.ts`) | Task 10 põe `["cobranca"]` |
| D4 | Linhas do baseline (`:19215`, `:42990`, `:43777`…) | arquivo com 45873 linhas; a varredura anon está no cabeçalho `-- ---- VARREDURA anon:` (hoje `:44330`); `fn_create_tenant_with_owner` tem **3** definições, a última acima do `fn_accept_team_invite` | Plano ancora por nome, nunca por linha |
| D5 | `fn_suspender`/`fn_reativar` "não citam `cobranca_assinaturas`" | confirmado: as do PR 1 usam `fn_org_parada_descarta_fila`, que a spec não cita | Task 4 copia a definição vigente inteira |
| D6 | Policy `tenant_isolation_cobranca_assinaturas_select` | CLAUDE.md fala em `tenant_isolation_<tabela>_all`; policy só de leitura por papel é o molde da spec 13 §4 | Mantém o nome da spec; se alguma varredura exigir `_all`, renomear (checar no CI) |
| D7 | `lint:channels` | catraca contra provedor de **canal** nas features; `Stripe`/`Asaas` só entram no PR 3a | Fora deste PR; Task 0 registra a checagem para o 3a |
| D8 | Migration "a próxima livre" | `main` até 0501, em voo até 0507 | Provisório 0508, renumerar no merge |

## Sobreposição com PRs abertos (medida em 02/10/2026)

- **#1967 (Draven9, gestão de tenants):** toca `app/api/v1/admin/tenants/**`, `components/admin/tenants/TenantActions.tsx` e a migration `0492`. Mesma área do card de cobrança no tenant (Task 14) e do formulário de novo tenant (Task 21). Releia o diff antes de começar cada uma e mescle a `main` antes.
- **#2078 (webtecnica, `support_readonly` não escreve em `organizations`):** toca o `baseline.sql` e as policies de `organizations` (risco residual 2 da spec e issue #2000). Não conflita em arquivo com este PR, mas conflita em posição do apêndice: mescle a `main` antes de colar o bloco.
- **#2019 (webtecnica, `/account-suspended` sai de `PUBLIC_PATHS`):** não toca este PR.
- **#2009 e outros PRs de migration:** só o número.

Se algum desses entrar antes, este plano muda **só** a tarefa afetada.

## Entrega em 5 PRs

| PR | O quê | Depende de | Prova |
|---|---|---|---|
| **2a Banco** | Tarefas 0–8: migration, baseline, MANIFEST, tipos, vocabulário, colunas mortas | `main` | `pnpm test:db` (install + update) + unit |
| **2b Chave e admin** | Tarefas 9–14: módulo, `/admin/sistema`, rotas e telas do dono, barra do admin | 2a | unit + e2e do dono |
| **2c Limites na ponta** | Tarefas 15–16: mensagens 409 e o convite | 2a | unit + invariantes |
| **2d Teto de IA** | Tarefas 17–19 | 2a | unit + invariante |
| **2e Telas da empresa** | Tarefas 20–26: billing leitura, faixa, novo tenant, i18n, mapa, e2e, fechamento | 2a–2d | e2e (CI) + prova pela tela |

Cada sub-PR é revisável sozinho e deixa a `main` verde. 2c e 2d podem andar em paralelo depois da 2a.

## Living System Checklist (DoD 13 — respondido por peça)

| Peça | Quem me alimenta | Quem eu alimento | Registro | Tela | Porta | Anti-morte | Configuração | Laço |
|---|---|---|---|---|---|---|---|---|
| `cobranca_planos` | `POST/PATCH /api/v1/admin/cobranca/planos` | `fn_limite_do_plano`, formulário de novo tenant, atribuição | `audit` `cobranca.plano_salvo/arquivado` | `/admin/cobranca › Planos` | `AdminSidebar` com `modulo:'cobranca'` | plano arquivado some das telas e mantém quem já o tem (preço travado com assinante) | `/admin/cobranca › Planos` | limite errado → o dono edita o plano; efeito imediato nas travas |
| `cobranca_assinaturas` | atribuição do dono, `fn_trial_na_criacao_da_org`, `fn_create_tenant_with_owner` | `fn_limite_do_plano`, painel da empresa, faixa de trial | `audit` `cobranca.estado_mudou/plano_trocado/prazo_concedido/isencao_definida` | `/admin/cobranca › Clientes`, card no tenant, `/app/settings/billing` | idem + menu da empresa | **Nenhum neste PR**, com justificativa: sem a régua (PR 3a) nada muda de estado sozinho; o trial vencido é só leitura aqui | idem | dono vê e corrige pelo card |
| Trava de assentos | `user_organizations` (insert/update) | recusa `PT402` → 409 `plan_limit_reached` | mensagem na tela de equipe; sem audit próprio (a recusa não muta) | Equipe, aceite de convite | menu Equipe | recusa ensina o caminho ("remova alguém ou troque de plano") | plano | **Nenhum**: a recusa não gera dado novo; a justificativa é a mensagem com saída |
| Trava de canais | `channel_sessions` | idem | idem | Conexões | menu Conexões | idem | plano | idem |
| Teto de IA | `llm_calls`/`fn_gasto_de_ia_do_mes` | `LlmBudgetExceededError` → handoff humano + item `budget_exceeded` `ref_kind='plano'` | item na Central | Central | Central | conversa vai para humano, não fica muda | plano | gasto no mês seguinte zera; o dono ajusta o teto |
| Interruptor `MODULO_COBRANCA` | `/admin/sistema` | todas as rotas, funções e telas acima | `platform.modulo_updated` + `cobranca.modulo_desligado` | `/admin/sistema` | menu admin | desligar libera as suspensas por cobrança (`fn_cobranca_liberar_suspensoes`) | a própria tela | desligar desfaz tudo; nada é cancelado fora |

Artefatos concretos (nomes exatos): `lib/cobranca/vocabulario.ts`, `lib/cobranca/limites.ts`, `lib/cobranca/plano.ts`, `lib/agent-engine/edge/llm/orcamento.ts#decidirTetoDoPlano`, `docs/architecture/cobranca-do-revendedor.architecture.json`.

## Mapa de arquivos

- **Banco:** `supabase/migrations/<ts>_<NNNN>_cobranca_planos_e_assinaturas.sql` (novo), `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`, `tests/invariants/cobranca-isolamento.test.ts`, `tests/invariants/cobranca-limites.test.ts`, `tests/invariants/rls-isolation.test.ts` (`cobranca_assinaturas` em `TABLES`), `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `docs/specs/01-spec-platform-base.md`.
- **Vocabulário e lógica pura:** `lib/cobranca/vocabulario.ts` (+ teste), `lib/cobranca/plano.ts` (+ teste), `lib/cobranca/limites.ts` (+ teste).
- **Chave e admin:** `lib/instalacao/modulos.ts` (+ teste), `lib/recursos-opcionais/catalogo.ts`, `app/app/settings/recursos/page.tsx`, `app/admin/(protected)/sistema/{page,_form}.tsx`, `app/actions/settings/updateModuloDaInstalacao.ts`, `components/admin/AdminSidebar.tsx`, `app/admin/(protected)/layout.tsx`, `app/api/v1/admin/cobranca/planos/{route.ts,[id]/route.ts}`, `app/api/v1/admin/tenants/[id]/assinatura/{route.ts,prazo/route.ts}`, `app/admin/(protected)/cobranca/page.tsx` e `_client.tsx`, `components/admin/tenants/TenantOverview.tsx`, `lib/audit/actions.ts`.
- **Limites na ponta:** rotas de canais e de equipe listadas na Task 15, `lib/auth/aplicar-convite.ts`, `app/api/v1/team/invite/route.ts`, `app/api/v1/team/[user_id]/reactivate/route.ts`, `lib/api/errors.ts`.
- **Teto de IA:** `lib/agent-engine/edge/llm/{orcamento,run-model-call}.ts`, `workers/ai-response-worker.ts`, `lib/ai/inbox-destino.ts`, `app/api/v1/ai/budget/route.ts`.
- **Telas da empresa:** `app/app/settings/billing/page.tsx`, `components/cobranca/PainelDaAssinatura.tsx`, `app/app/layout.tsx`, `lib/navigation/catalogo.ts`, `lib/i18n/dicionario.ts`, `app/admin/(protected)/tenants/new/_form.tsx`, `lib/schemas/tenant-creation.ts`, `app/api/v1/admin/tenants/route.ts`.
- **Prova e docs:** `tests/e2e/cobranca-suspensao-e-limites.spec.ts`, `tests/e2e/cobranca-desligada.spec.ts`, `.github/workflows/e2e.yml` (`SPECS_PARTE_*`), `docs/testing/user-journey-map.md`, `docs/architecture/cobranca-do-revendedor.architecture.json`, `.changes/*.md`, `lib/campanhas/rodada.ts` (só se o comentário ainda for o falso), `CLAUDE.md` (só se algo que ele afirma ficou falso).

---

# PR 2a — Banco

### Task 0: Worktree e linha de base

**Files:** nenhum.

- [ ] **Step 1: Criar o worktree da 2a**

```bash
cd "D:/PROJETOS VIBE CODING/DeskcommCRM" && git fetch origin
git worktree add .claude/worktrees/cobranca-2a-banco -b feat/cobranca-planos-e-assinaturas origin/main
cd .claude/worktrees/cobranca-2a-banco && pnpm install --frozen-lockfile
```

- [ ] **Step 2: Reconferir a base e o número**

```bash
git rev-parse --short origin/main          # o SHA do dia; se não for efed1d574, releia as 3 tarefas que dizem "medido em"
pnpm checar:colisao-de-migration           # só mede depois de a migration existir; rode de novo na Task 8
ls supabase/migrations | sed 's#.*/##' | sed -nE 's#^[0-9]{14}_([0-9]{4})_.*#\1#p' | sort | tail -2
```

Anote o maior número da `main` e o maior em voo (`gh pr view <n> --json files` nos PRs abertos); o seu é o seguinte aos dois. Se for diferente de `0508`, troque o número em todo este plano ao executar.

- [ ] **Step 3: Medir de novo as quatro âncoras que este plano usa**

```bash
grep -n "revoked_at" supabase/baseline.sql | grep -i "user_organizations" | head -2
grep -nE "provider.*not null|DEFAULT 'waha'" supabase/baseline.sql | head -3
grep -c "create or replace function public.fn_suspender_organizacao" supabase/baseline.sql   # esperado: 1
grep -c "create or replace function public.fn_reativar_organizacao" supabase/baseline.sql    # esperado: 1
```

Se `fn_suspender`/`fn_reativar` tiverem mais de uma definição, a Task 4 usa a **última**.

- [ ] **Step 4 (3a, não agora): registrar para o PR 3a** que `pnpm lint:channels` precisa ser medido quando `Stripe`/`Asaas` entrarem em `lib/cobranca/provedores/`. Não é deste PR.

### Task 1: Vocabulário TypeScript e o par com o banco

**Files:**
- Create: `lib/cobranca/vocabulario.ts`, `lib/cobranca/vocabulario.test.ts`
- Modify: `tests/invariants/vocabulario-banco-x-typescript.test.ts`

**Interfaces:**
- Produces: `ESTADOS_DA_ASSINATURA`, `PROVEDORES_DE_COBRANCA`, `MODOS`, `INTERVALOS`, `AVISOS_DA_REGUA`, `ERROS_DE_LEITURA`, `RECURSOS_DO_PLANO` e os tipos derivados. O 3a os consome.

- [ ] **Step 1: Escrever o teste que falha**

`lib/cobranca/vocabulario.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  AVISOS_DA_REGUA,
  ERROS_DE_LEITURA,
  ESTADOS_DA_ASSINATURA,
  INTERVALOS,
  MODOS,
  PROVEDORES_DE_COBRANCA,
  RECURSOS_DO_PLANO,
} from "./vocabulario";

describe("vocabulário da cobrança", () => {
  it("os literais são exatamente os dos CHECKs da migration", () => {
    expect([...ESTADOS_DA_ASSINATURA]).toEqual(["trial", "ativa", "em_atraso", "cancelada"]);
    expect([...PROVEDORES_DE_COBRANCA]).toEqual(["stripe", "asaas"]);
    expect([...MODOS]).toEqual(["teste", "producao"]);
    expect([...INTERVALOS]).toEqual(["mes", "ano"]);
    expect([...AVISOS_DA_REGUA]).toEqual(["trial_acabando", "venceu", "suspende_em_breve", "suspensa"]);
    expect([...ERROS_DE_LEITURA]).toEqual([
      "credencial_invalida",
      "provedor_fora",
      "pagamento_de_assinatura_cancelada",
      "leitura_invalida",
    ]);
  });

  it("os recursos do plano são os três que fn_limite_do_plano aceita", () => {
    expect([...RECURSOS_DO_PLANO]).toEqual(["assentos", "canais", "ia_usd_cents"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm exec vitest run lib/cobranca/vocabulario.test.ts` → falha por módulo ausente.

- [ ] **Step 3: Implementar**

`lib/cobranca/vocabulario.ts`:

```ts
/**
 * O vocabulário da cobrança do revendedor (ADR-0004; spec §2.7). Cada lista é
 * espelho de um CHECK da migration `cobranca_planos_e_assinaturas`, e o par é
 * vigiado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 *
 * Sem `next/*` nem `server-only`: o motor do agente o carrega sob `tsx`.
 */
export const ESTADOS_DA_ASSINATURA = ["trial", "ativa", "em_atraso", "cancelada"] as const;
export type EstadoDaAssinatura = (typeof ESTADOS_DA_ASSINATURA)[number];

export const PROVEDORES_DE_COBRANCA = ["stripe", "asaas"] as const;
export type ProvedorDeCobranca = (typeof PROVEDORES_DE_COBRANCA)[number];

export const MODOS = ["teste", "producao"] as const;
export type Modo = (typeof MODOS)[number];

export const INTERVALOS = ["mes", "ano"] as const;
export type Intervalo = (typeof INTERVALOS)[number];

export const AVISOS_DA_REGUA = ["trial_acabando", "venceu", "suspende_em_breve", "suspensa"] as const;
export type AvisoDaRegua = (typeof AVISOS_DA_REGUA)[number];

export const ERROS_DE_LEITURA = [
  "credencial_invalida",
  "provedor_fora",
  "pagamento_de_assinatura_cancelada",
  "leitura_invalida",
] as const;
export type ErroDeLeitura = (typeof ERROS_DE_LEITURA)[number];

/** Os três recursos que `public.fn_limite_do_plano(org, recurso)` aceita; outro valor lança 22023. */
export const RECURSOS_DO_PLANO = ["assentos", "canais", "ia_usd_cents"] as const;
export type RecursoDoPlano = (typeof RECURSOS_DO_PLANO)[number];
```

- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: O par com o banco.** Em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, siga o molde das entradas vizinhas (leia o cabeçalho do arquivo: ele só cobre colunas que **já têm CHECK**) e acrescente `cobranca_assinaturas.estado`, `.provedor`, `.modo`, `.ultimo_aviso`, `.ultimo_erro` e `cobranca_planos.intervalo`, `.moeda` contra as constantes acima. Esse teste só roda depois da Task 2 (precisa do banco).
- [ ] **Step 6: Commit** `feat(cobranca): o vocabulário da cobrança do revendedor`.

### Task 2: Migration — as duas tabelas

**Files:**
- Create: `supabase/migrations/20261002130000_0508_cobranca_planos_e_assinaturas.sql`

- [ ] **Step 1: Escrever a primeira parte da migration (tabelas)**

```sql
-- Cobrança do revendedor — PR 2 (ADR-0004, spec §2.2 e §2.3). Capacidade do NÚCLEO
-- com chave da instalação (MODULO_COBRANCA), DESLIGADA por padrão. As duas tabelas
-- nascem VAZIAS em toda instalação (48 kB, medido na ADR-0004). Empresa sem linha em
-- cobranca_assinaturas é isenta: nenhum limite, nenhuma régua.

-- ── 1. Planos (da instalação; sem organization_id; sem policy, molde de platform_config) ──
create table if not exists public.cobranca_planos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 60),
  preco_cents bigint not null check (preco_cents >= 500),
  moeda text not null default 'BRL' check (moeda = 'BRL'),
  intervalo text not null check (intervalo in ('mes','ano')),
  trial_dias integer not null default 14 check (trial_dias between 0 and 90),
  max_assentos integer check (max_assentos >= 1),
  max_canais integer check (max_canais >= 1),
  teto_ia_usd_cents integer check (teto_ia_usd_cents >= 100),
  padrao_no_cadastro boolean not null default false,
  arquivado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create unique index if not exists cobranca_planos_um_padrao
  on public.cobranca_planos ((true)) where padrao_no_cadastro and arquivado_em is null;

drop trigger if exists trg_cobranca_planos_updated_at on public.cobranca_planos;
create trigger trg_cobranca_planos_updated_at
  before update on public.cobranca_planos
  for each row execute function public.fn_set_updated_at();

alter table public.cobranca_planos enable row level security;
revoke all on public.cobranca_planos from anon, authenticated;
grant select, insert, update, delete on public.cobranca_planos to service_role;

-- ── 2. Assinaturas (uma linha por organização) ──
create table if not exists public.cobranca_assinaturas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plano_id uuid not null references public.cobranca_planos(id) on delete restrict,
  plano_agendado_id uuid references public.cobranca_planos(id) on delete restrict,
  estado text not null default 'trial' check (estado in ('trial','ativa','em_atraso','cancelada')),
  trial_ate timestamptz,
  provedor text check (provedor in ('stripe','asaas')),
  modo text check (modo in ('teste','producao')),
  provedor_cliente_id text,
  provedor_assinatura_id text,
  vencida_desde timestamptz,
  proximo_vencimento timestamptz,
  cancela_no_fim boolean not null default false,
  prazo_extra_ate timestamptz,
  ultimo_aviso text check (ultimo_aviso in ('trial_acabando','venceu','suspende_em_breve','suspensa')),
  ultimo_aviso_em timestamptz,
  checkout_url text,
  checkout_expira_em timestamptz,
  relida_em timestamptz,
  assinaturas_vivas integer not null default 0,
  ultimo_erro text check (ultimo_erro in ('credencial_invalida','provedor_fora','pagamento_de_assinatura_cancelada','leitura_invalida')),
  ultimo_erro_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provedor is null) = (provedor_cliente_id is null))
);

create unique index if not exists cobranca_assinaturas_cliente
  on public.cobranca_assinaturas (provedor, provedor_cliente_id) where provedor is not null;

drop trigger if exists trg_cobranca_assinaturas_updated_at on public.cobranca_assinaturas;
create trigger trg_cobranca_assinaturas_updated_at
  before update on public.cobranca_assinaturas
  for each row execute function public.fn_set_updated_at();

alter table public.cobranca_assinaturas enable row level security;

drop policy if exists tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas;
create policy tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas
  for select to authenticated using (public.fn_role_at_least(organization_id, 'admin'));

revoke all on public.cobranca_assinaturas from anon, authenticated;
grant select on public.cobranca_assinaturas to authenticated;
grant select, insert, update, delete on public.cobranca_assinaturas to service_role;
```

Por que assim, e o que **não** fazer:
- Limites em colunas, não `jsonb` (anti-pattern 6). Nome distinto de `account_plans` (que já existe).
- O `revoke` + `grant` explícitos importam: o default ACL do Supabase daria `ALL` a `authenticated` (CLAUDE.md, audit log).
- CPF/CNPJ **não** é guardado aqui (LGPD); a linha guarda só ponteiros.

- [ ] **Step 2: Invariante de isolamento (escrever antes de aplicar)** — `tests/invariants/cobranca-isolamento.test.ts`, no molde de `org-suspensa.test.ts` (`lastLine`, `sql` de `./gov-helpers`). Casos, todos com **duas organizações** A e B:

  1. admin de A (JWT) lê só a linha de A em `cobranca_assinaturas`; `agent` de A lê **0** linhas; admin de A não vê a linha de B;
  2. `authenticated` não escreve: `insert`, `update` e `delete` por JWT de admin de A → `42501` (confira o `SQLSTATE`, não só "falhou");
  3. `anon` não lê nada;
  4. `cobranca_planos` invisível a `authenticated` (`select` devolve 0 ou 42501, conforme o `revoke`);
  5. índice `cobranca_planos_um_padrao`: dois planos `padrao_no_cadastro` não arquivados → `23505`; arquivar um libera;
  6. índice `cobranca_assinaturas_cliente`: mesmo `(provedor, provedor_cliente_id)` em duas orgs → `23505`; `provedor` nulo repetido é permitido;
  7. `check ((provedor is null) = (provedor_cliente_id is null))`: `provedor='stripe'` sem cliente → `23514`;
  8. `on delete cascade`: apagar a org apaga a assinatura; `on delete restrict`: apagar plano com assinatura → `23503`.

  Adicione `cobranca_assinaturas` em `TABLES` de `tests/invariants/rls-isolation.test.ts`.

- [ ] **Step 3: Rodar `pnpm test:db tests/invariants/cobranca-isolamento.test.ts`** (onde houver Docker; no fork, o CI) e ver o conjunto passar com a migration e falhar **sem** ela.

### Task 3: As três funções de leitura

**Files:** Modify: a migration da Task 2 (acrescenta ao fim).

- [ ] **Step 1: Escrever o teste** em `tests/invariants/cobranca-limites.test.ts` (novo): `fn_limite_do_plano` devolve nulo com a chave ausente, com `desligado` e com a org sem assinatura; devolve o teto certo de cada um dos três recursos com a chave `ligado` e a org com plano; recurso desconhecido lança `22023` **mesmo com a chave desligada**; plano sem teto (`max_assentos is null`) devolve nulo. `fn_cobranca_liberar_suspensoes` reativa só as `suspended{cobranca}`, devolve a contagem e não toca a `suspended{administrativa}` nem a ativa.

- [ ] **Step 2: Implementar**

```sql
-- ── 3. Funções de leitura ──
create or replace function public.fn_cobranca_ligada() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_config
                  where chave = 'MODULO_COBRANCA' and valor = 'ligado')
$$;
revoke execute on function public.fn_cobranca_ligada() from public, anon, authenticated;
grant  execute on function public.fn_cobranca_ligada() to service_role;

create or replace function public.fn_limite_do_plano(p_org uuid, p_recurso text) returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_plano public.cobranca_planos%rowtype;
begin
  -- Recurso desconhecido é erro de programação e falha SEMPRE, com a chave ligada ou não.
  if p_recurso is null or p_recurso not in ('assentos', 'canais', 'ia_usd_cents') then
    raise exception 'recurso_do_plano_invalido' using errcode = '22023';
  end if;
  if not public.fn_cobranca_ligada() then
    return null;
  end if;
  select p.* into v_plano
    from public.cobranca_assinaturas a
    join public.cobranca_planos p on p.id = a.plano_id
   where a.organization_id = p_org;
  if not found then
    return null; -- empresa isenta
  end if;
  return case p_recurso
    when 'assentos'     then v_plano.max_assentos
    when 'canais'       then v_plano.max_canais
    else                     v_plano.teto_ia_usd_cents
  end;
end;
$$;
revoke execute on function public.fn_limite_do_plano(uuid, text) from public, anon, authenticated;
grant  execute on function public.fn_limite_do_plano(uuid, text) to service_role;

create or replace function public.fn_cobranca_liberar_suspensoes(p_ator uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_n   integer := 0;
  v_r   jsonb;
begin
  for v_org in
    select o.id from public.organizations o
     where o.status = 'suspended' and o.suspended_kind = 'cobranca'
  loop
    v_r := public.fn_reativar_organizacao(v_org, 'cobranca', p_ator);
    if coalesce((v_r->>'changed')::boolean, false) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.fn_cobranca_liberar_suspensoes(uuid) from public, anon, authenticated;
grant  execute on function public.fn_cobranca_liberar_suspensoes(uuid) to service_role;
```

Notas: `fn_limite_do_plano` e `fn_cobranca_ligada` rodam como `definer` porque os gatilhos (que rodam como quem escreveu) precisam lê-las sem `EXECUTE`. `fn_cobranca_liberar_suspensoes` depende de `fn_reativar_organizacao` — existe desde o PR 1.

- [ ] **Step 3: Rodar e ver passar.** Depois **sabote** o `if not public.fn_cobranca_ligada() then return null` (comente a linha), reaplique, e confirme que o caso "chave desligada devolve nulo" fica **vermelho**; restaure e confirme a presença com `grep -c`.

### Task 4: Redefinir `fn_suspender_organizacao` e `fn_reativar_organizacao`

**Files:** Modify: a migration (acrescenta ao fim).

Mudanças, e só elas (spec §2.6 e §11):
- `fn_suspender_organizacao`: com `p_kind = 'cobranca'`, organização **sem** linha em `cobranca_assinaturas` → `{changed:false, motivo:'org_isenta'}`.
- `fn_reativar_organizacao`: depois do `update organizations`, zerar `ultimo_aviso`/`ultimo_aviso_em` da assinatura (passo 7 da §3.1).

- [ ] **Step 1: Extrair a última definição vigente de cada uma, sem digitar**

```bash
python3 - <<'PY'
import re
s = open("supabase/baseline.sql", encoding="utf-8", newline="").read()
for nome in ("fn_suspender_organizacao", "fn_reativar_organizacao"):
    i = s.rfind(f"create or replace function public.{nome}(")
    j = s.index("$$;", s.index("as $$", i)) + 3
    print(nome, "->", s[i:j].count("\n"), "linhas")
PY
```

(`rfind`, nunca `find`: CLAUDE.md, migrations, item 10. O `newline=""` evita a troca de fim de linha no Windows.) Cole cada corpo na migration, **inteiro**, e faça só as duas edições abaixo com a ferramenta de edição, não com script.

- [ ] **Step 2: Teste primeiro** — em `tests/invariants/cobranca-limites.test.ts`: (a) `fn_suspender_organizacao(org, 'cobranca', ...)` numa org **sem** assinatura devolve `{"changed": false, "motivo": "org_isenta"}` e não altera `status`; com assinatura suspende; (b) `fn_reativar_organizacao(org, 'cobranca', ...)` zera `ultimo_aviso` e `ultimo_aviso_em`; (c) **todo o `tests/invariants/org-suspensa.test.ts` continua verde** (é a prova de que a cópia não reverteu o PR 1).

- [ ] **Step 3: As duas edições**

Em `fn_suspender_organizacao`, logo depois do bloco `if not found then raise exception 'organization_not_found' ...; end if;`:

```sql
  if p_kind = 'cobranca'
     and not exists (select 1 from public.cobranca_assinaturas a where a.organization_id = p_org) then
    return jsonb_build_object('changed', false, 'motivo', 'org_isenta');
  end if;
```

Em `fn_reativar_organizacao`, logo depois do `update public.organizations set status = 'active', ... where id = p_org;`:

```sql
  update public.cobranca_assinaturas
     set ultimo_aviso = null, ultimo_aviso_em = null
   where organization_id = p_org;
```

Repita o `revoke`/`grant` das duas, idênticos aos do PR 1 (`from public, anon, authenticated` + `to service_role`).

- [ ] **Step 4: Rodar `pnpm test:db tests/invariants/org-suspensa.test.ts tests/invariants/cobranca-limites.test.ts`.** Sabote a linha `org_isenta` e confirme o caso (a) vermelho.

### Task 5: Gatilho de assentos (dois gatilhos, não um)

**Files:** Modify: a migration (acrescenta ao fim); `tests/invariants/cobranca-limites.test.ts`.

- [ ] **Step 1: Escrever os testes primeiro** (todos com duas orgs):
  1. teto 2: 1º e 2º `insert` ativos passam, o 3º → `PT402` (confira o SQLSTATE e a mensagem `plan_limit_reached`);
  2. **duas conexões concorrentes** no teto 2 com 1 vaga livre: exatamente uma passa (o lock por organização);
  3. membro provisório (`provisional_until_handover`) **não conta**;
  4. `⭐` `INSERT` com `provisional_until_handover = true` por JWT de **admin do tenant** (caminho PostgREST) → `42501`, com a mensagem do gatilho; como `service_role` passa;
  5. `UPDATE provisional_until_handover=false` num provisório acima do teto → `PT402`;
  6. `UPDATE revoked_at = null` (reativar) acima do teto → `PT402`;
  7. `UPDATE organization_id` de um membro para uma org cheia → `PT402`;
  8. org com 5 membros e plano de 3 (atribuído depois): **nenhum é derrubado**, o 6º é recusado, reativar um revogado é recusado (Review Focus 2);
  9. chave desligada **ou** org sem linha: nunca recusa, mesmo com 100 membros;
  10. os seeds de e2e (membros inseridos por `service_role` sem plano) passam.

- [ ] **Step 2: Implementar**

```sql
-- ── 4a. Provisório só pelo servidor — INVOKER, de propósito ──
-- Dentro de função security definer, current_user é o DONO, nunca quem chamou: a mesma
-- checagem num gatilho definer jamais dispararia. Molde: fn_organizacao_estado_so_pelo_servidor.
create or replace function public.fn_provisorio_so_pelo_servidor() returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.provisional_until_handover and current_user in ('authenticated', 'anon') then
    raise exception 'vinculo_provisorio_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Vínculo provisório nasce só em fn_create_tenant_with_owner, nunca pela sessão.';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_provisorio_so_pelo_servidor() from public, anon, authenticated;

drop trigger if exists trg_provisorio_so_pelo_servidor on public.user_organizations;
create trigger trg_provisorio_so_pelo_servidor
  before insert or update of provisional_until_handover on public.user_organizations
  for each row execute function public.fn_provisorio_so_pelo_servidor();

-- ── 4b. Teto de assentos — DEFINER (lê as tabelas da cobrança) ──
create or replace function public.fn_trava_assentos_do_plano() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_teto   integer;
  v_usados integer;
begin
  -- Só conta quem passa a OCUPAR vaga.
  if new.revoked_at is not null or new.provisional_until_handover then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and not (old.revoked_at is not null
              or old.provisional_until_handover
              or old.organization_id is distinct from new.organization_id) then
    return new;
  end if;

  v_teto := public.fn_limite_do_plano(new.organization_id, 'assentos');
  if v_teto is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2282));
  select count(*) into v_usados
    from public.user_organizations uo
   where uo.organization_id = new.organization_id
     and uo.revoked_at is null
     and not uo.provisional_until_handover
     and uo.user_id <> new.user_id;
  if v_usados >= v_teto then
    raise exception 'plan_limit_reached' using errcode = 'PT402', detail = 'assentos';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_trava_assentos_do_plano() from public, anon, authenticated;

drop trigger if exists trg_trava_assentos_do_plano on public.user_organizations;
create trigger trg_trava_assentos_do_plano
  before insert or update of revoked_at, provisional_until_handover, organization_id on public.user_organizations
  for each row execute function public.fn_trava_assentos_do_plano();
```

- [ ] **Step 3: Rodar** e ver os 10 casos passarem. **Sabote** (a) o `security invoker` do 4a trocando por `security definer` e confirme o caso 4 vermelho (prova a divergência D1); (b) a linha `v_usados >= v_teto` e confirme os casos 1, 2, 5, 6, 7 vermelhos. Restaure e confira a presença.

- [ ] **Step 4: Commit** `feat(cobranca): trava de assentos por plano e vínculo provisório só pelo servidor`.

### Task 6: Trava de canais, teste grátis na criação e `fn_create_tenant_with_owner`

**Files:** Modify: a migration; `tests/invariants/cobranca-limites.test.ts`.

- [ ] **Step 1: Testes primeiro.**
  - **Canais:** teto 1: o 1º `channel_sessions` ativo passa, o 2º → `PT402`; `provider = 'wacalls'` **não** conta; arquivar (`archived_at`) libera; desarquivar acima do teto → `PT402`; `UPDATE organization_id` para org cheia → `PT402`; chave desligada ou org sem linha: nunca recusa; **`fn_reserve_channel_connection` (que já toma o lock `2281`) continua funcionando** com o gatilho (o `pg_advisory_xact_lock` é reentrante na mesma transação, e este caso prova que não há deadlock).
  - **Teste grátis:** chave ligada + plano `padrao_no_cadastro` + org inserida com `created_by` = usuário comum → nasce `trial` com `trial_ate = now() + trial_dias`; `created_by` = platform admin → nada; chave desligada → nada; sem plano padrão → nada; `created_by` nulo → nada.
  - **`fn_create_tenant_with_owner`:** com `plano_id` e chave ligada → cria a assinatura `trial` na mesma transação; `plano_id` com a chave **desligada** → `22023`; `plano_id` arquivado ou inexistente → `22023`; **sem `plano_id` e sem `plan`, `settings` fica `{}`; com `plan`, `settings.plan` é gravado como hoje**; a criação **provisória** (tenant para outra pessoa) continua funcionando como `service_role` (Review Focus 5); réplica idempotente (mesmo `p_key`) devolve o recibo sem criar segunda assinatura.

- [ ] **Step 2: Implementar a trava de canais**

```sql
-- ── 5. Teto de canais de mensagem — DEFINER ──
create or replace function public.fn_trava_canais_do_plano() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_teto   integer;
  v_usados integer;
begin
  if new.archived_at is not null or new.provider = 'wacalls' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and not (old.archived_at is not null
              or old.provider = 'wacalls'
              or old.organization_id is distinct from new.organization_id) then
    return new;
  end if;

  v_teto := public.fn_limite_do_plano(new.organization_id, 'canais');
  if v_teto is null then
    return new;
  end if;

  -- A MESMA chave de lock de fn_reserve_channel_connection (2281): as duas disputam o mesmo teto.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2281));
  select count(*) into v_usados
    from public.channel_sessions s
   where s.organization_id = new.organization_id
     and s.archived_at is null
     and s.provider <> 'wacalls'
     and s.id <> new.id;
  if v_usados >= v_teto then
    raise exception 'plan_limit_reached' using errcode = 'PT402', detail = 'canais';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_trava_canais_do_plano() from public, anon, authenticated;

drop trigger if exists trg_trava_canais_do_plano on public.channel_sessions;
create trigger trg_trava_canais_do_plano
  before insert or update of archived_at, provider, organization_id on public.channel_sessions
  for each row execute function public.fn_trava_canais_do_plano();
```

A contagem exclui só `wacalls` (a coluna `provider` é `not null default 'waha'`, medido). Teste unitário `lib/cobranca/limites.test.ts` (Task 15) compara o conjunto contado com `PROVIDERS_DE_MENSAGEM` de `lib/channels/capabilities.ts`: se um provider novo de mensagem entrar, o teste reprova até a contagem ser revista.

- [ ] **Step 3: Teste grátis na criação**

```sql
-- ── 6. Teste grátis na criação da organização ──
create or replace function public.fn_trial_na_criacao_da_org() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_plano public.cobranca_planos%rowtype;
begin
  if new.created_by is null or not public.fn_cobranca_ligada() then
    return new;
  end if;
  if exists (select 1 from public.platform_admins pa
              where pa.user_id = new.created_by and pa.revoked_at is null) then
    return new; -- o tenant do dono recebe o plano explícito do formulário
  end if;
  select p.* into v_plano from public.cobranca_planos p
   where p.padrao_no_cadastro and p.arquivado_em is null;
  if not found then
    return new;
  end if;
  insert into public.cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
  values (new.id, v_plano.id, 'trial', now() + make_interval(days => v_plano.trial_dias))
  on conflict (organization_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.fn_trial_na_criacao_da_org() from public, anon, authenticated;

drop trigger if exists trg_trial_na_criacao_da_org on public.organizations;
create trigger trg_trial_na_criacao_da_org
  after insert on public.organizations
  for each row execute function public.fn_trial_na_criacao_da_org();
```

Isto só alcança criação por **servidor** (o INSERT de organização pela sessão já é recusado desde o PR 1): `ensureTenantForUser`, as quatro portas do cadastro e `provisionExternalTenant` (`lib/auth/provision.ts`).

- [ ] **Step 4: `fn_create_tenant_with_owner`** — extraia a **última** definição (mesmo script `rfind` da Task 4), cole inteira e faça só estas duas edições.

(1) No `insert into public.organizations`, troque `jsonb_build_object('plan', p_request->>'plan')` por:

```sql
      case when nullif(p_request->>'plan', '') is null
           then '{}'::jsonb
           else jsonb_build_object('plan', p_request->>'plan') end
```

(2) Logo depois do `insert into public.user_organizations(...)`:

```sql
  if nullif(p_request->>'plano_id', '') is not null then
    if not public.fn_cobranca_ligada() then
      raise exception 'plano_requer_cobranca_ligada' using errcode = '22023';
    end if;
    insert into public.cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
    select org.id, p.id, 'trial', now() + make_interval(days => p.trial_dias)
      from public.cobranca_planos p
     where p.id = (p_request->>'plano_id')::uuid and p.arquivado_em is null;
    if not found then
      raise exception 'plano_invalido' using errcode = '22023';
    end if;
  end if;
```

Repita `revoke all ... from public, anon, authenticated; grant execute ... to service_role;` idênticos aos da definição que você copiou.

- [ ] **Step 5: Rodar tudo, sabotar** o `provider <> 'wacalls'` (troque por `true`) e confirme o caso `wacalls não conta` vermelho; sabotar o `if not found then raise ... 'plano_invalido'` e confirmar o caso do plano inexistente vermelho. Restaurar e conferir.
- [ ] **Step 6: Commit** `feat(cobranca): trava de canais, teste grátis na criação e plano na criação de tenant`.

### Task 7: Colunas mortas

**Files:** Modify: a migration; `lib/database.types.ts`; `docs/specs/01-spec-platform-base.md`; `docs/business-rules/00-business-rules-catalog.md`.

- [ ] **Step 1: Reconfirmar que ninguém lê** (medido em `efed1d574`: só o baseline, a spec 01, o catálogo de regras e os tipos geram as duas colunas; zero em `app`, `lib`, `workers`, `components`, `hooks`, `scripts`, `tests`):

```bash
grep -rnE "ai_budget_cents|rate_limit_rps" --include=*.ts --include=*.tsx app lib workers components hooks scripts tests | grep -v database.types
```

Esperado: vazio. Se aparecer algo, **pare**: a spec só autoriza a remoção sem leitor.

- [ ] **Step 2: Migration** (no fim, depois dos gatilhos):

```sql
-- ── 7. Colunas mortas (spec §2.1): zero leitor, nada visível ao operador ──
alter table public.organizations drop column if exists ai_budget_cents;
alter table public.organizations drop column if exists rate_limit_rps;
```

O rollback de imagem pelo `agent.sh` não quebra: a imagem anterior não as lê.

- [ ] **Step 3:** remova as duas colunas de `lib/database.types.ts` (`Row`, `Insert`, `Update` de `organizations`); atualize `docs/specs/01-spec-platform-base.md` (linhas das duas colunas) e a regra B-04 do catálogo de regras (a prosa já antecipa a remoção; troque o comando de verificação por um que diga se a coluna ainda existe).
- [ ] **Step 4: Commit** `chore(db): remove as colunas organizations.ai_budget_cents e rate_limit_rps, sem leitor`.

### Task 8: A tripla e a prova do banco inteiro

**Files:** Modify: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`.

- [ ] **Step 1: Apêndice do baseline.** Cole **o mesmo SQL** da migration como bloco rotulado, imediatamente **acima** do cabeçalho `-- ---- VARREDURA anon:`. Confira:

```bash
grep -n "VARREDURA anon:" supabase/baseline.sql | head -1
grep -n "cobrança: planos e assinaturas" supabase/baseline.sql   # tem de vir ANTES da linha acima
```

- [ ] **Step 2: MANIFEST** — uma linha no fim da tabela "Applied":

`| `20261002130000` | `0508_cobranca_planos_e_assinaturas` | **A cobrança do revendedor ganha o banco (spec PR 2).** Duas tabelas vazias (`cobranca_planos`, `cobranca_assinaturas`), três funções de leitura, as travas de pessoas e de números por plano, o teste grátis na criação da empresa e o plano na criação de tenant — tudo inerte com a chave desligada ou sem plano atribuído. Remove as colunas mortas `organizations.ai_budget_cents` e `rate_limit_rps`. Nada muda para quem não liga a cobrança. |`

- [ ] **Step 3: Tipos** — adicione `cobranca_planos` e `cobranca_assinaturas` a `lib/database.types.ts` no formato gerado (`Row`/`Insert`/`Update`/`Relationships`), copiando o de uma tabela vizinha como molde.
- [ ] **Step 4: Cercas estáticas** — `pnpm exec vitest run tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts tests/unit/kind-check-migration-x-baseline.test.ts tests/unit/baseline-no-piso-do-postgres.test.ts` e o teste do MANIFEST (`ls tests/unit | grep -i manifest`). Todos verdes.
- [ ] **Step 5: Banco, install e update** — `pnpm test:db` e `pnpm test:db:update` (onde houver Docker; no fork, o CI). Inclua os invariantes existentes que varrem tudo: `hardening-definer-varredura`, `travas-de-suporte-cobrem-toda-tabela-na-instalacao`, `vocabulario-banco-x-typescript`, `rls-isolation`.
- [ ] **Step 6: Colisão** — `pnpm checar:colisao-de-migration` (agora há migration acrescentada, então ele mede). Resolva qualquer colisão renumerando.
- [ ] **Step 7: Fragmento** `.changes/cobranca-planos-e-assinaturas.md`:

```markdown
---
impacto: nada_mudou
secao: alterado
titulo: A base da cobrança do revendedor chega ao banco, ainda desligada
---
Quem instala o CRM para outras empresas ganha, no banco de toda instalação, as tabelas de planos e assinaturas e as travas de pessoas e de números por plano. Nada disso vale enquanto a cobrança estiver desligada, e a chave ainda não pode ser ligada pela tela. Também saem duas colunas antigas de `organizations` que nenhuma tela lia. Crédito: @paulolimajr77.
```

- [ ] **Step 8: Abrir o PR 2a** no repositório do Rafael, com o corpo: o que muda para quem usa; `Closes`/`Refs #2108`; o que foi medido (rodapé do `test:unit`, a sabotagem de cada trava, o resultado do `test:db`); **"O que NÃO medi"**; e a declaração de destino (DoD 18): **núcleo**, razão medida pela pergunta "se nenhuma organização ativar isto, a operação comum continua inteira?" — sim, continua (tabelas vazias, funções devolvem nulo).

---

# PR 2b — Chave e admin

### Task 9: O módulo `cobranca` e o interruptor

**Files:**
- Modify: `lib/instalacao/modulos.ts`, `lib/instalacao/modulos.test.ts`, `lib/recursos-opcionais/catalogo.ts`, `tests/unit/recursos-opcionais-catalogo.test.ts`, `app/app/settings/recursos/page.tsx`, `app/admin/(protected)/sistema/_form.tsx`

Adicionar um módulo por chave toca **7 arquivos** (medido pelo molde `crm_b2b`); o `Record<ModuloOpcional, …>` exaustivo de `TEXTO_DO_MODULO` faz o compilador apontar o que faltar.

- [ ] **Step 1: Testes primeiro** em `lib/instalacao/modulos.test.ts`: `MODULOS_OPCIONAIS_POR_FLAG` contém `cobranca`; `CHAVE_DO_MODULO.cobranca === "MODULO_COBRANCA"`; `MODULOS_AINDA_NAO_LIGAVEIS` contém `cobranca`; `MODULOS_SO_DA_INSTALACAO` é exatamente `["cobranca"]`; `modulosLigados` devolve `cobranca` só com a linha `ligado` (e **não** com `desligado`, ausente ou erro de leitura — falha fechada). Em `tests/unit/recursos-opcionais-catalogo.test.ts`: a lista que a empresa vê em Recursos opcionais **não** inclui `cobranca`.

- [ ] **Step 2: `lib/instalacao/modulos.ts`**

```ts
export const MODULOS_OPCIONAIS = [
  "banco_externo", "fluxos_atendimento", "propostas", "crm_b2b", "honorarios", "cobranca",
] as const;

export const MODULOS_OPCIONAIS_POR_FLAG = [
  "banco_externo", "fluxos_atendimento", "propostas", "crm_b2b", "cobranca",
] as const satisfies readonly ModuloOpcional[];

// em CHAVE_DO_MODULO:
  // ADR-0004: a cobrança do revendedor. Só o dono do servidor liga; a empresa nunca a vê
  // em Recursos opcionais (MODULOS_SO_DA_INSTALACAO). Falha fechada: só o valor `ligado` a liga.
  cobranca: "MODULO_COBRANCA",

/** Módulos que existem no código mas ainda não podem ser ligados pela tela. */
export const MODULOS_AINDA_NAO_LIGAVEIS: readonly ModuloOpcional[] = ["cobranca"];

/** Módulos que só quem administra o servidor enxerga: nunca listados para a empresa. */
export const MODULOS_SO_DA_INSTALACAO: readonly ModuloOpcional[] = ["cobranca"];
```

Atualize o comentário de `MODULOS_AINDA_NAO_LIGAVEIS` ("vazia: …" deixa de ser verdade; diga que `cobranca` sai da lista no PR 3a, quando a Stripe permite uma assinatura real).

- [ ] **Step 3: `lib/recursos-opcionais/catalogo.ts`** — em `TEXTO_DO_MODULO`:

```ts
  cobranca: {
    nome: "Cobrança dos seus clientes",
    oQueFaz: "Planos, teste grátis e limites por empresa, para quem instala o CRM e cobra as empresas que atende.",
  },
```

- [ ] **Step 4: `app/app/settings/recursos/page.tsx`** — na linha que monta `modulos` (hoje `RECURSOS_OPCIONAIS.filter((r) => r.nivel === "instalacao" && r.modulo)`), exclua `MODULOS_SO_DA_INSTALACAO`:

```ts
const modulos = RECURSOS_OPCIONAIS.filter(
  (r) => r.nivel === "instalacao" && r.modulo && !MODULOS_SO_DA_INSTALACAO.includes(r.modulo),
);
```

- [ ] **Step 5: `app/admin/(protected)/sistema/_form.tsx`** — acrescentar a entrada em `MODULOS_NA_TELA`:

```ts
  {
    modulo: "cobranca",
    id: "modulo-cobranca",
    rotulo: "Cobrança dos seus clientes",
    descricao:
      "Ligado, você cria planos, dá teste grátis às empresas novas e trava, por plano, quantas pessoas, quantos números e quanto de IA cada empresa usa. Empresas que já existem ficam isentas até você atribuir um plano. Desligado, nada disso aparece e nenhum limite vale. Esta etapa ainda não pode ser ligada por aqui: o pagamento chega numa próxima versão.",
  },
```

Mostre o interruptor **desabilitado** com o texto "ainda não disponível" quando o módulo está em `MODULOS_AINDA_NAO_LIGAVEIS` (o `updateModuloDaInstalacao` já recusa com `modulo_ainda_nao_disponivel`; a tela não pode oferecer o que a ação recusa).

- [ ] **Step 6:** `pnpm typecheck` e os testes do Step 1 verdes. Sabotar: tire `cobranca` de `MODULOS_SO_DA_INSTALACAO` e confirme que o teste da lista da empresa fica vermelho.
- [ ] **Step 7: Commit** `feat(cobranca): o módulo cobranca, travado na tela e invisível à empresa`.

### Task 10: Desligar a chave libera as suspensas

**Files:** Modify: `app/actions/settings/updateModuloDaInstalacao.ts`, `app/admin/(protected)/sistema/page.tsx`, `app/admin/(protected)/sistema/_form.tsx`, `lib/audit/actions.ts`; teste `app/actions/settings/updateModuloDaInstalacao.test.ts` (crie se não houver).

`escritaDeAdminOuRecusa()` já é o primeiro passo da action (medido): a exigência de `scope full` + MFA da spec **já está cumprida**; não troque o helper.

- [ ] **Step 1: Teste primeiro:** desligar `cobranca` chama `rpc('fn_cobranca_liberar_suspensoes', { p_ator })` **depois** de `gravarModulo` e audita `cobranca.modulo_desligado` com `{ liberadas }`; desligar qualquer **outro** módulo não chama a RPC; ligar `cobranca` devolve `modulo_ainda_nao_disponivel` (e não grava); se a RPC falhar, a action devolve `{ ok:false }` e **não** esconde o erro (a chave já foi gravada: devolva `release_failed` e deixe a tela mostrar "desligado, mas N empresas ainda suspensas: tente de novo").
- [ ] **Step 2: Implementar** o ramo, logo depois do `gravarModulo`:

```ts
  if (modulo === "cobranca" && !ligado) {
    const { data, error } = await db.rpc("fn_cobranca_liberar_suspensoes", { p_ator: user.id });
    if (error) return { ok: false, error: "release_failed" };
    await audit({
      action: "cobranca.modulo_desligado",
      actorUserId: user.id,
      resourceType: "platform_config",
      metadata: { liberadas: typeof data === "number" ? data : 0 },
      requestId: hdrs.get("x-request-id"),
      ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: hdrs.get("user-agent"),
    });
  }
```

(mova a leitura de `hdrs` para antes do ramo.) Acrescente `"cobranca.modulo_desligado"` ao fim de `lib/audit/actions.ts`.
- [ ] **Step 3: `sistema/page.tsx`** — lê N = `count` de `organizations` com `status='suspended'` e `suspended_kind='cobranca'` (admin client) e passa à tela, que mostra, na linha da cobrança quando ela está ligada: "Ao desligar, N empresas suspensas por falta de pagamento serão liberadas. Nada é cancelado no provedor." (i18n `es`).
- [ ] **Step 4: Commit** `feat(cobranca): desligar a chave libera as empresas suspensas por cobrança`.

### Task 11: Regras puras do plano

**Files:** Create: `lib/cobranca/plano.ts`, `lib/cobranca/plano.test.ts`.

Código puro, sem banco, para as rotas da Task 12 e para a troca de plano do 3a reusarem.

- [ ] **Step 1: Testes primeiro** — `validarPlano`: preço < 500 → `preco_minimo`; nome vazio ou > 60 → `nome_invalido`; `trial_dias` fora de 0–90 → `trial_invalido`; `max_assentos`/`max_canais` < 1 → `limite_invalido`; `teto_ia_usd_cents` < 100 → `limite_invalido`; limites omitidos = sem teto (nulo). `podeMudarPrecoOuIntervalo(plano, assinantes)`: com qualquer assinatura em `plano_id` **ou** `plano_agendado_id` → `false`. `caberNoPlano(uso, plano)`: devolve `{ cabe, excedente: { assentos?, canais? } }` só com os excedentes > 0 (a lista que a tela transforma em "remova 2 pessoas e 1 número").
- [ ] **Step 2: Implementar**

```ts
import { INTERVALOS, type Intervalo } from "./vocabulario";

export const PRECO_MINIMO_CENTS = 500; // R$ 5: mínimo de boleto nos dois provedores (spec §2.2)

export interface PlanoDeEntrada {
  nome: string;
  preco_cents: number;
  intervalo: Intervalo;
  trial_dias: number;
  max_assentos: number | null;
  max_canais: number | null;
  teto_ia_usd_cents: number | null;
}

export type ErroDePlano = "nome_invalido" | "preco_minimo" | "intervalo_invalido" | "trial_invalido" | "limite_invalido";

export function validarPlano(p: PlanoDeEntrada): ErroDePlano | null {
  if (p.nome.trim().length < 1 || p.nome.trim().length > 60) return "nome_invalido";
  if (!Number.isInteger(p.preco_cents) || p.preco_cents < PRECO_MINIMO_CENTS) return "preco_minimo";
  if (!(INTERVALOS as readonly string[]).includes(p.intervalo)) return "intervalo_invalido";
  if (!Number.isInteger(p.trial_dias) || p.trial_dias < 0 || p.trial_dias > 90) return "trial_invalido";
  for (const [valor, minimo] of [[p.max_assentos, 1], [p.max_canais, 1], [p.teto_ia_usd_cents, 100]] as const) {
    if (valor !== null && (!Number.isInteger(valor) || valor < minimo)) return "limite_invalido";
  }
  return null;
}

export function podeMudarPrecoOuIntervalo(assinantes: number): boolean {
  return assinantes === 0;
}

export interface Uso { assentos: number; canais: number }
export interface Excedente { assentos?: number; canais?: number }

/** Quanto do uso atual passa do plano novo — só os excedentes > 0. Teto nulo = sem limite. */
export function excedenteDoUso(uso: Uso, plano: Pick<PlanoDeEntrada, "max_assentos" | "max_canais">): Excedente {
  const ex: Excedente = {};
  if (plano.max_assentos !== null && uso.assentos > plano.max_assentos) ex.assentos = uso.assentos - plano.max_assentos;
  if (plano.max_canais !== null && uso.canais > plano.max_canais) ex.canais = uso.canais - plano.max_canais;
  return ex;
}
```

- [ ] **Step 3:** rodar, ver passar; sabotar `p.preco_cents < PRECO_MINIMO_CENTS` (troque por `<=`) e ver o caso do preço exato de R$ 5 ficar vermelho. Commit.

### Task 12: Rotas do dono — planos e assinatura

**Files:**
- Create: `app/api/v1/admin/cobranca/planos/route.ts`, `app/api/v1/admin/cobranca/planos/[id]/route.ts`, `app/api/v1/admin/tenants/[id]/assinatura/route.ts`, `app/api/v1/admin/tenants/[id]/assinatura/prazo/route.ts` e um `route.test.ts` ao lado de cada
- Modify: `lib/api/errors.ts`, `lib/audit/actions.ts`

Códigos de erro novos (todos pelo `ok()`/`fail()` de `lib/api/wrappers.ts`; entram em `lib/api/errors.ts`): `plano_invalido` (422), `plano_com_assinantes` (409), `plan_limit_reached` (409), `cobranca_desligada` (404, reaproveita o 404 genérico se já houver), `assinatura_ja_existe` (409 `state_conflict`), `prazo_invalido` (422).

Ações de `audit` novas, no fim de `lib/audit/actions.ts` (os nomes são os da lista da spec §13; **atribuir** um plano a uma empresa sem linha audita `cobranca.plano_trocado` com `de: null`): `cobranca.plano_salvo`, `cobranca.plano_arquivado`, `cobranca.plano_trocado`, `cobranca.prazo_concedido`, `cobranca.isencao_definida`, `cobranca.modulo_desligado`.

**Onde a spec cala e este plano decide** (confirmar com o Rafael no PR 2b): nesta entrega a coluna `provedor` é **sempre nula** (a Stripe é do 3a), então não há dinheiro em jogo e a troca de plano de uma assinatura sem provedor vale **na hora**, em qualquer estado. A regra D-3 ("só na próxima cobrança paga") nasce junto com o provedor, no 3a; os ramos que dependem de `provedor is not null` **não** são escritos aqui (seriam código inalcançável).

Todas as rotas começam por: (1) `requirePlatformAdminEscrita()` (+ `falhaDaEscritaDePlatformAdmin`), (2) **404 se `fn_cobranca_ligada()` for falso** (rota de cobrança com a chave desligada não existe), (3) `requireSupportWrite(` antes do efeito, (4) Zod no corpo (`z.strictObject`, nunca campo desconhecido), (5) `audit` no sucesso, (6) `X-Request-Id`.

- [ ] **Step 1: `POST /api/v1/admin/cobranca/planos`** — corpo `{ nome, preco_cents, intervalo, trial_dias?, max_assentos?, max_canais?, teto_ia_usd_cents?, padrao_no_cadastro? }` → `validarPlano` → `insert` por service role; conflito do índice de padrão (`23505`) → 409 `state_conflict`. Teste: preço 499 → 422; dois padrões → 409; chave desligada → 404; `support_readonly` → 403 `forbidden_scope`; sucesso audita `cobranca.plano_salvo`.
- [ ] **Step 2: `PATCH /api/v1/admin/cobranca/planos/[id]`** — mesmos campos + `arquivado: boolean`. Mudar `preco_cents` ou `intervalo` com assinante em `plano_id` **ou** `plano_agendado_id` → 409 `plano_com_assinantes` ("arquive e crie outro"). Arquivar um plano em uso é permitido (só impede novas atribuições) e audita `cobranca.plano_arquivado`; o plano `padrao_no_cadastro` arquivado perde a marca.
- [ ] **Step 3: `POST /api/v1/admin/tenants/[id]/assinatura`** `{ plano_id }` — sem linha: cria `trial` com `trial_ate = now() + trial_dias` do plano; **linha existente → 409 `state_conflict`**; plano arquivado → 422 `plano_invalido`. `PATCH` na mesma rota `{ plano_id }` = trocar plano: **nunca** mexe em `estado`, `trial_ate` nem `vencida_desde`; vale na hora (ver "onde a spec cala"). Downgrade abaixo do uso: `excedenteDoUso` com o uso atual (`count` de `user_organizations` e de `channel_sessions` pelas **mesmas regras das travas**) → 409 `plan_limit_reached` com `details.excedente`. `DELETE` na mesma rota = tornar isenta: apaga a linha. Se a org estava `suspended{cobranca}`, chama `fn_reativar_organizacao(org,'cobranca',ator)` depois.
- [ ] **Step 4: `POST /api/v1/admin/tenants/[id]/assinatura/prazo`** `{ ate }` — `ate` deve ser futuro e ≤ 60 dias (senão 422 `prazo_invalido`); grava `prazo_extra_ate`; se a suspensão é de cobrança, reativa na hora. Audita `cobranca.prazo_concedido`.
- [ ] **Step 5: Cercas** — `tests/unit/suporte-cobertura-de-efeitos.test.ts` e `tests/unit/admin-escrita-exige-scope-full.test.ts` continuam verdes (as rotas novas devem estar cobertas); rode-os.
- [ ] **Step 6: Commit** por rota, `feat(cobranca): <rota>`.

### Task 13: A barra do admin só mostra o que está ligado

**Files:** Modify: `components/admin/AdminSidebar.tsx`, `app/admin/(protected)/layout.tsx`; teste `tests/unit/admin-navegacao-completude.test.ts` (já existe).

- [ ] **Step 1: Testes primeiro** — item `{ href:'/admin/cobranca', label:'Cobrança', modulo:'cobranca' }` aparece com `modulosLigados` contendo `cobranca` e **some** sem ele; os demais itens (sem `modulo`) não mudam; `admin-navegacao-completude` reconhece o destino.
- [ ] **Step 2: Implementar** — `NavItem` ganha `modulo?: ModuloOpcional`; `AdminSidebar` recebe `modulosLigados: readonly ModuloOpcional[]` e filtra; o layout admin lê `modulosLigados(createAdminClient())` (já há leitura análoga em `sistema/page.tsx`) e passa. **Sem a chave o menu é idêntico ao de hoje.**
- [ ] **Step 3: Commit.**

### Task 14: `/admin/cobranca` (Planos e Clientes) e o card no tenant

**Files:**
- Create: `app/admin/(protected)/cobranca/page.tsx`, `app/admin/(protected)/cobranca/_client.tsx`
- Modify: `components/admin/tenants/TenantOverview.tsx`, `components/admin/tenants/TenantActions.tsx` (**conferir #1967 antes**), `lib/i18n/dicionario.ts`

- [ ] **Step 1:** `page.tsx` (servidor): `requirePlatformAdmin()`; **404 com a chave desligada** (`notFound()`); lê planos (arquivados à parte) e assinaturas com o nome da empresa, pelo admin client; passa ao `_client`.
- [ ] **Step 2: Aba Planos** — lista (nome, preço em reais, intervalo, teste, limites, "plano do cadastro"), formulário de criar e editar chamando as rotas da Task 12, recusa preço < R$ 5 com a mensagem da validação, aviso "preço e intervalo travam quando há assinante", ação arquivar. Textos em linguagem simples ("Teste grátis de N dias", "Sem limite" para nulo).
- [ ] **Step 3: Aba Clientes** — empresa, plano, estado, teste até, próximo vencimento, ações: **Atribuir plano** (sem linha), **Trocar plano**, **Dar prazo até DD/MM** (≤ 60 dias), **Tornar isenta**. Cada ação é um botão que chama a rota correspondente e mostra o erro do servidor traduzido ("Esta empresa tem 7 pessoas e o plano permite 5: remova 2").
- [ ] **Step 4: Card "Cobrança" em `/admin/tenants/[id]`** — só com a chave ligada: plano, estado, atribuir/trocar/dar prazo/isentar, e "Rótulo antigo: X" (só leitura) se `settings.plan` existir. **Com a chave desligada, `TenantOverview.tsx:98-99,118-119` segue idêntico** (badge de `settings.plan`). O `TenantActions` mostra o **tipo** da suspensão (administrativa × cobrança) lido de `suspended_kind`; "Reativar" só para a administrativa; para a de cobrança, "Dar prazo" e "Isentar".
- [ ] **Step 5: i18n** — toda chave nova com `es` (e `zh-CN` onde o painel exige) no mesmo commit, `grep -c` antes de colar.
- [ ] **Step 6: Provar pela tela** (DoD 12) — Playwright, banco fresco do `baseline.sql` + `bootstrap-owner`, `next build`/`next start`, envs opcionais **ausentes**: o dono liga a chave **por fixture** (a tela recusa), cria um plano de 1 pessoa e 1 número, atribui a uma empresa, vê o card. Evidência em `evidence/cobranca-planos/`.
- [ ] **Step 7: Commit e abrir o PR 2b** (corpo com o que **não** foi medido: o fluxo ligado pela tela, que só existe no 3a).

---

# PR 2c — Limites na ponta

### Task 15: Tradução do `PT402` em 409 com mensagem que ensina

**Files:** Create: `lib/cobranca/limites.ts`, `lib/cobranca/limites.test.ts`. Modify: as rotas abaixo.

- [ ] **Step 1: Medir os pontos de entrada hoje** (re-meça; os da spec são `lib/channels/connect-waha.ts`, `app/api/v1/channels/official/route.ts`, `lib/channels/connect.ts`, `lib/channels/social/store.ts`, `lib/channels/graph-parceiro/session.ts` e as ressurreições em `lib/channels/reactivate.ts`):

```bash
grep -rnE "\.(insert|upsert)\(" lib/channels/connect.ts lib/channels/social/store.ts lib/channels/graph-parceiro/session.ts "app/api/v1/channels/official/route.ts" "app/api/v1/voice/sessions/pair/route.ts"
grep -rn "fn_reserve_channel_connection" --include=*.ts app lib | grep -v test
grep -rn "channel-sessions\|onboarding/whatsapp/session" -l --include=route.ts app/api/v1 | head
```

O **gatilho do banco já barra todos os caminhos** (inclusive os que escapem da lista); a lista só diz onde traduzir o erro. `voice/sessions/pair` cria canal `wacalls`, que não conta.
- [ ] **Step 2: Testes primeiro** (`limites.test.ts`): `traduzirLimiteDoPlano({ code:"PT402", details:"assentos" })` devolve `{ status:409, code:"plan_limit_reached", message: "...pessoas..." }`; com `details:"canais"` a mensagem fala de números conectados; erro sem `PT402` devolve `null`; a mensagem **ensina a saída** ("Remova alguém em Equipe ou troque de plano em Configurações › Plano e cobrança" / "Arquive um número em Conexões ou troque de plano"); e o teste que compara o conjunto contado pela trava com `PROVIDERS_DE_MENSAGEM` (Task 6).
- [ ] **Step 3: Implementar** `traduzirLimiteDoPlano(err: { code?: string; details?: string; message?: string }): { status: 409; code: "plan_limit_reached"; message: string } | null`; aplique nas rotas de canais (o resultado vira `fail("plan_limit_reached", msg, 409)`). Registre `plan_limit_reached` em `lib/api/errors.ts`.
- [ ] **Step 4: Commit.**

### Task 16: Convites, aceite e reativação de membro

**Files:** Modify: `lib/auth/aplicar-convite.ts`, `app/api/v1/team/invite/route.ts`, `app/api/v1/team/[user_id]/reactivate/route.ts`, `lib/auth/provision.ts` (só leitura: confirmar que usa service role, onde a trava vale mesmo assim).

- [ ] **Step 1: Testes primeiro.**
  - **Aceite** (`aplicar-convite.ts`): hoje o erro vira `internal_error` (qualquer código ≠ `42501`). Com `PT402`, o motivo passa a `limite_do_plano`; a tela de aceite mostra "A empresa que te convidou atingiu o limite de pessoas do plano. Avise quem te convidou." Acrescente `"limite_do_plano"` ao tipo `motivo` e ao `Resultado`.
  - **Emitir convite** (`team/invite`): com o limite já cheio, a tela **avisa antes** de mandar o e-mail (aviso, não autoridade: a trava de verdade é no aceite — decisão D-10: só membros **ativos** contam, convite pendente não).
  - **Reativar membro:** `team/[user_id]/reactivate` com `PT402` → 409 `plan_limit_reached` ("Seu plano permite N pessoas e todas as vagas estão ocupadas. Remova alguém em Equipe ou troque de plano em Configurações › Plano e cobrança.").
- [ ] **Step 2: Implementar** os três; **não** bloqueie a emissão do convite (D-10); o aviso usa a mesma contagem das travas (`revoked_at is null and not provisional_until_handover`).
- [ ] **Step 3: Prova pela tela** (DoD 12): admin de B convida, o convidado aceita com o limite cheio e vê a mensagem; evidência.
- [ ] **Step 4: Commit e PR 2c.**

---

# PR 2d — Teto de IA

### Task 17: Decisão pura do teto do plano

**Files:** Modify: `lib/agent-engine/edge/llm/orcamento.ts`, `tests/unit/orcamento-decisao.test.ts` (as decisões atuais moram aí) ou o novo `lib/agent-engine/edge/llm/orcamento.test.ts`.

- [ ] **Step 1: Testes primeiro** para `decidirTetoDoPlano({ tetoUsdCents, gastoUsdCents, origemDaChave, purpose })`: `origemDaChave === 'credencial_da_organizacao'` (BYOK) **nunca** bloqueia; `purpose` em `PURPOSES_ISENTOS` segue; teto nulo não bloqueia; `gasto >= teto` bloqueia; `gasto < teto` não; o `modo 'off'` de `ai_budgets` da org **não** desliga o teto do plano; a chave de emergência `AI_BUDGET_ENFORCEMENT=off` **desliga** o teto do plano também (decisão D-9).
- [ ] **Step 2: Implementar** a função pura, ao lado das decisões de orçamento existentes. Não importe nada de servidor.

### Task 18: O teto no motor e no worker legado

**Files:** Modify: `lib/agent-engine/edge/llm/orcamento.ts` (`lerTetoDoPlano`), `lib/agent-engine/edge/llm/run-model-call.ts` (`aplicarOrcamento`), `workers/ai-response-worker.ts` (`vetoPorTetoDeGasto`).

- [ ] **Step 1: NÃO mexer em `SQL_CONFIG_COM_ORCAMENTO`** (`lib/agent-engine/edge/llm/credentials.ts`): o `catch` dele troca para a query legada em qualquer erro e **desliga o orçamento de toda org**; pendurar a função nova ali amarraria o orçamento existente a ela. A consulta é separada.
- [ ] **Step 2: `lerTetoDoPlano(db, org)`** — `select public.fn_limite_do_plano($1,'ia_usd_cents') as teto, public.fn_gasto_de_ia_do_mes($1) as gasto`, **só** quando a origem da chave é `chave_da_instalacao`, com `try/catch` próprio: erro → teto indisponível (log com o SQLSTATE), a chamada **segue**, o orçamento da org fica intacto. Teste: injetar `42883` (função inexistente, imagem antiga) na consulta e provar que o `modo` de `ai_budgets` continua aplicado.
- [ ] **Step 3: Ordem em `aplicarOrcamento`** — `chave === 'off'` (alavanca de emergência) → retorna; **teto do plano**; `orcamentoIndisponivelPorque` → retorna; `modo === 'off'` → retorna; orçamento da org. Instalação sem a chave de cobrança: `fn_limite_do_plano` devolve nulo e **nem consulta o gasto**.
- [ ] **Step 4: Worker legado** — `workers/ai-response-worker.ts` decide o veto **antes** de resolver a origem da chave (`vetoPorTetoDeGasto` na linha ~198, `resolverModeloDoPonto` na ~228, medido). O teto do plano precisa rodar **depois** da resolução, ou a resolução sobe para antes do veto; escolha a que mexe em menos linhas e prove com um caso no worker.
- [ ] **Step 5: Bloqueio** — reusa `LlmBudgetExceededError` → handoff humano (`HANDOFF_REASON_ORCAMENTO`). Texto para a empresa: "O uso de IA incluído no plano acabou neste mês. As conversas foram para a equipe. Troque de plano, cadastre uma chave de IA própria ou aguarde o próximo mês."

### Task 19: O aviso do teto na Central, sem pisar no do orçamento da org

**Files:** Modify: `lib/ai/inbox-destino.ts`, `lib/agent-engine/edge/llm/run-model-call.ts`, `workers/ai-response-worker.ts`, `app/api/v1/ai/budget/route.ts`.

Três ajustes **juntos** (spec §5), e cada um tem teste:
1. `"plano"` entra em `InboxRefKind` e nos `refs` de `budget_exceeded` (`lib/ai/inbox-destino.ts`, hoje `refs: ["ai_budget"]`): sem isso, ref fora da lista vira "Este contexto não está disponível para você".
2. O dedupe do aviso (em `run-model-call.ts` e no worker legado) passa a filtrar `ref_kind`: senão o item do plano cala o do orçamento da org e vice-versa.
3. `retratarAvisos` (`app/api/v1/ai/budget/route.ts`) passa a filtrar `ref_kind = 'ai_budget'`: senão afrouxar o orçamento da org fecha o aviso do plano.

Item: `kind='budget_exceeded'`, `ref_kind='plano'`, `ref_id=<org>`. O aviso de **80%** é do cron da cobrança (PR 3a); não entra aqui.

- [ ] **Step 1: Testes primeiro** para os três ajustes (cada um vermelho sem o ajuste); sabotar um por um.
- [ ] **Step 2: Invariante** — org com plano de teto 100 centavos e gasto simulado em `llm_calls`: o gasto passa do teto, `fn_gasto_de_ia_do_mes` ≥ teto, a decisão pura bloqueia; BYOK com o mesmo gasto não bloqueia.
- [ ] **Step 3: Commit e PR 2d.**

---

# PR 2e — Telas da empresa e fechamento

### Task 20: `/app/settings/billing` leitura e a faixa de teste

**Files:** Create: `components/cobranca/PainelDaAssinatura.tsx`. Modify: `app/app/settings/billing/page.tsx`, `app/app/layout.tsx`.

- [ ] **Step 1:** **Com a chave desligada, `app/app/settings/billing/page.tsx` fica idêntico ao de hoje** (53 linhas de placeholder; teste de regressão com a chave desligada). Ligada: `PainelDaAssinatura` só leitura — estado em linguagem simples ("Teste grátis até DD/MM", "Sem cobrança"), uso contra limites (pessoas x/y, números x/y, IA US$ gasto/teto) e, sem assinatura, "Sua empresa não tem cobrança".
- [ ] **Step 2:** faixa em `app/app/layout.tsx` para admin, só com `cobranca` em `modulosLigados` e assinatura em `trial` com `trial_ate − agora ≤ 7 dias`: "Teste grátis: faltam N dias". **Esta entrega não tem o botão "Assinar"** (é do 3a): a faixa só informa.
- [ ] **Step 3:** leitura da assinatura pela **sessão** (RLS: só admin da empresa lê a linha); sem service role no componente.
- [ ] **Step 4: i18n `es`** e commit.

### Task 21: Formulário de novo tenant, dois modos

**Files:** Modify: `app/admin/(protected)/tenants/new/_form.tsx`, `lib/schemas/tenant-creation.ts`, `app/api/v1/admin/tenants/route.ts` (**conferir #1967 antes**).

- [ ] **Step 1: Testes primeiro** — chave **desligada**: o formulário e o payload são os de hoje (`plan: standard|pro|enterprise`, default `standard`). Chave **ligada**: select de `cobranca_planos` (não arquivados) + "Sem cobrança (isenta)"; o payload leva `plano_id` e **não** leva `plan`.
- [ ] **Step 2: Schema** — `plano_id: z.string().uuid().optional()` ao lado de `plan`, com `refine`: `plano_id` e `plan` não vêm juntos. A rota passa `plano_id` a `fn_create_tenant_with_owner` (a Task 6 já a trata) e, no `audit`, `metadata.plano_id`.
- [ ] **Step 3: Provar pela tela** — criar uma empresa nos dois modos; evidência.

### Task 22: A porta do menu da empresa

**Files:** Modify: `lib/navigation/catalogo.ts`, `lib/i18n/dicionario.ts`, `tests/unit/navegacao-registry.test.ts` (e `i18n-catalogo-do-menu`).

- [ ] O item de `/app/settings/billing` hoje tem `label: "Billing"` (e "Plano e cobrança." só na descrição). A mensagem do limite de pessoas manda a pessoa a "Configurações › Plano e cobrança": o rótulo muda para **"Plano e cobrança"**, com `es` ("Plan y facturación") e `zh-CN`. **Sem `modulo`** no item: ele não pode sumir com a chave desligada (promessa D-2: nada muda). Testes verdes (`navegacao-completude`, `i18n-catalogo-do-menu`, `i18n-espanhol-cobre-a-tela`).

### Task 23: Mapa vivo (DoD 13)

**Files:** Create: `docs/architecture/cobranca-do-revendedor.architecture.json`.

- [ ] Siga `docs/architecture/README.md` (**sem re-render**) e o molde de `recursos-opcionais`, `teto-de-orcamento`, `organizacoes-e-acesso` e `central-avisos`; cada nó com **≥ 2 arestas reais dentro do mapa novo**; nó para `event_log` (não há mapa dele). Peças: planos, assinaturas, as três travas, o interruptor, as rotas do dono, o painel da empresa. Rode o teste que valida os mapas (`tests/unit/mapas-de-arquitetura.test.ts`).

### Task 24: E2E no CI

**Files:** Create: `tests/e2e/cobranca-suspensao-e-limites.spec.ts` (etapas de plano), `tests/e2e/cobranca-desligada.spec.ts`. Modify: `.github/workflows/e2e.yml` (`SPECS_PARTE_*`).

- [ ] **`cobranca-suspensao-e-limites.spec.ts`** (sem provedor; o fixture grava `platform_config.MODULO_COBRANCA='ligado'` direto no banco): o dono cria um plano (1 pessoa, 1 número) e o atribui a B; o convite em B é **recusado** com a mensagem do plano; a conexão de um segundo número é recusada; o dono troca o plano, dá prazo e torna a empresa isenta pelo card, e o convite passa a funcionar. A suspensão **por cobrança** (a régua) e o passo "dono liga pela tela" são do 3a e **não** entram aqui; a suspensão administrativa já tem a sua spec desde o PR 1 (`suspensao-administrativa.spec.ts`).
- [ ] **`cobranca-desligada.spec.ts`:** o self-hoster de empresa única (chave desligada) vê o formulário de novo tenant, o badge de `settings.plan` e a tela Billing **como antes**, nenhuma faixa, nenhum item de admin, e Recursos opcionais **sem** cobrança.
- [ ] Spec nova entra em `SPECS_PARTE_*` (ou em `FORA_DO_CI` com motivo); `tests/unit/e2e-cobertura-completa.test.ts` reprova spec órfã.

### Task 25: Jornada, docs e fragmentos

- [ ] `docs/testing/user-journey-map.md`: nova jornada `[P0]` "o dono cria um plano e trava uma empresa" com casos e a evidência de `evidence/cobranca-planos/`.
- [ ] Reler os documentos de autoridade que afirmam estado sobre o que mudou (DoD 16), só nos que este PR toca: `docs/doctrine/operacao-de-agentes.md` (a pergunta que substitui o grep antigo), `docs/business-rules/00-business-rules-catalog.md` (B-01, B-02, B-04), `docs/specs/01-spec-platform-base.md`. Onde der, troque número por **comando**.
- [ ] `lib/campanhas/rodada.ts`: o comentário "falso" que a spec manda corrigir **já foi corrigido no PR 1** (confira com `git log -S` antes de tocar; se estiver certo, não mexa).
- [ ] Fragmentos por sub-PR (ver Global Constraints). `pnpm release:conferir` verde.

### Task 26: Verificação final de cada sub-PR

- [ ] Árvore mesclada com a `main` do dia: `git fetch origin && git merge origin/main`, `rm -f tsconfig*.tsbuildinfo`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`, `pnpm test:unit > /tmp/vt.log 2>&1; echo exit=$?`, depois o controle do rodapé contra o `grep FAIL` **e** a linha `Errors` (CLAUDE.md, Testes). `pnpm build`.
- [ ] `pnpm test:db` e `pnpm test:db:update` (onde houver Docker; no fork, o CI).
- [ ] e2e das specs novas (CI) e a prova pela tela com evidência em `evidence/`.
- [ ] `pnpm checar:colisao-de-migration` e `pnpm release:conferir`.
- [ ] Antes do PR: reler os comentários da issue #2108 e a lista de PRs abertos (reivindicação e trabalho paralelo), e conferir `gh pr view <n> --json maintainerCanModify`.

## O que este plano NÃO mediu

- **Nada foi executado.** Este é um plano de leitura: nenhum teste, nenhuma migration foi rodada. Os SQL das Tasks 2 a 7 foram escritos contra o código lido, mas **nunca aplicados**; o primeiro `pnpm test:db` é o primeiro contato deles com um Postgres.
- **Os efeitos de ordem entre gatilhos no mesmo `INSERT`** (por exemplo, `trg_provisorio_so_pelo_servidor` e `trg_trava_assentos_do_plano` na mesma linha) não foram medidos; o Postgres dispara `BEFORE` em ordem alfabética de nome, e o invariante 4 da Task 5 a exercita.
- **O nome de policy `_select`** (D6) contra as varreduras que exigem `tenant_isolation_<tabela>_all`: não confirmado.
- **`channel_sessions.provider` ser `not null default 'waha'`:** vem do comentário de `lib/channels/capabilities.ts`; não li o DDL. A contagem `provider <> 'wacalls'` descarta linhas com `provider` nulo; confirme no DDL antes da Task 6.
- **Se há outra `create function` depois do bloco da varredura anon no estado de hoje:** li o cabeçalho e a cerca, não rodei a cerca.
- **O caminho completo do worker legado** (Task 18, passo 4): li os dois pontos (`vetoPorTetoDeGasto`, `resolverModeloDoPonto`) e não o fluxo entre eles.
- **Os cinco pontos de entrada de `channel_sessions`** da Task 15 foram medidos por `grep` de `insert`/`upsert`; caminhos por RPC (`fn_reserve_channel_connection`) são cobertos pelo gatilho do banco, mas a lista de rotas onde traduzir o erro precisa ser refeita no dia.
- **Se `escritaDeAdminOuRecusa` basta** como guarda de MFA/scope para o desligar (Task 10): li o helper e sei que chama `requirePlatformAdminEscrita`; não li este último inteiro.
- **A forma exata das telas** (Tasks 14, 20) segue a spec §9; o desenho visual não foi decidido aqui.
- **PRs abertos que mexem na mesma área** (#1967, #2078) foram medidos só por lista de arquivos, não por diff.
