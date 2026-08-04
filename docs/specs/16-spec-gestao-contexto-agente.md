---
title: Spec Técnica 16 — Ciclo de Vida do Contexto do Agente
parent: 07-prd-gestao-contexto-agente.md
depends_on: 04-spec-pipeline-attendance.md, 05-spec-ai-rag-handoff.md, 10-spec-ai-agents-runtime.md, 15-spec-casos-humanos.md
version: 0.1
status: em revisão
date: 2026-08-02
owner: Renan Brandão
referencia_arquitetural: docs/prd/07-prd-gestao-contexto-agente.md
---

# Spec 16 — Ciclo de Vida do Contexto do Agente

> Detalhamento técnico do Sub-PRD 07. Define a função pura da fronteira de sessão, a marca de corte não-destrutiva em `contacts`, a política por etapa em `crm_stages`, o worker de expiração, o endpoint de hard reset e as strings exatas da UI. Nenhuma capacidade aqui adiciona provedor externo ou query nova no caminho quente do turno.

---

## 1. Visão Geral

Três camadas, três naturezas técnicas diferentes — e essa distinção é o que mantém a implementação pequena:

1. **Fronteira de sessão** — *leitura pura*. Uma função em TypeScript sobre o array de mensagens que o turno já leu. Zero schema, zero query, zero worker, zero estado. Desligar = passar `null`.
2. **Expiração por etapa** — *marca, não delete*. Um `timestamptz` em `contacts` escrito por um cron; três queries de leitura passam a filtrar por ele. Reverter = `set null`.
3. **Hard reset** — *delete físico*, um contato por vez, atrás de RBAC e confirmação digitada. É a única operação destrutiva da spec.

A ficha do cliente e o aviso de atendimento anterior são construídos no mesmo ponto onde o contexto é montado, a partir de `contacts` e `orders` — dado estruturado, nunca `rolling_summary`.

Princípios não-negociáveis:

- **Nada é apagado automaticamente.** Camadas 1 e 2 não emitem `delete`. O histórico do humano é intocável fora do hard reset.
- **Padrão de fábrica não esquece.** `resets_context` nasce `false` em toda etapa; org nova se comporta exatamente como hoje.
- **A política fala o vocabulário do tenant.** Nenhuma regra deriva de `is_won`/`is_lost` — só da marcação explícita na etapa.
- **`organization_id` de fonte confiável** em toda query, sempre (sessão, cookie ou secret de cron; nunca body).

---

## 2. Stack & Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Onde vive a marca de corte | `contacts.context_reset_at` | Checkpoint e `lead_state` são por contato; `conversations` é 1:1 com contato+canal. Um campo cobre as três leituras. |
| Cálculo da fronteira de sessão | Função pura em TS sobre o histórico já lido | Não adiciona query nem index; determinística e testável sem banco; desligável sem migração. |
| Semântica da fronteira | Último **intervalo de silêncio** ≥ N horas | "Mensagens das últimas 6h" cortaria conversa contínua longa ao meio — bug de negócio. |
| `lead_state` na expiração | Neutralizado **em leitura**, não sobrescrito | Mantém a promessa "nada é apagado" e torna o reset reversível de graça. |
| Política de expiração | Colunas em `crm_stages` | Precedente direto: `crm_stages.requires_human`. O tenant já edita essa tela. |
| Intervalo de sessão | `organizations.settings.context_lifecycle.session_gap_hours` | Precedente: `organizations.settings.routing`. Sem tabela nova. |
| Worker | Cron HTTP com Bearer secret | Padrão do repo (`app/api/v1/cron/*`); trigger nunca faz HTTP (doutrina). |
| Card do Kanban | Nenhum reset toca | Card é objeto de trabalho humano; PRD §3.6, risco R8. |
| RAG / Memória da IA | Fora das camadas 1 e 2 | Ativo do negócio, não memória de pessoa; PRD §3.11. |

---

## 3. Schema SQL

Migration **0100** — `supabase/migrations/20260802120000_0100_ciclo_de_vida_do_contexto.sql`.

```sql
-- ---- marca de corte do contexto do agente (migration 0100) ----
-- Não-destrutiva e reversível: enquanto NULL, comportamento idêntico ao atual.
-- Escrita pelo worker de expiração (política por etapa) ou pelo reset manual.
alter table contacts
  add column if not exists context_reset_at timestamptz,
  add column if not exists context_reset_reason text;

comment on column contacts.context_reset_at is
  'Corte do contexto do agente: mensagens, checkpoints e lead_state anteriores a este
   instante deixam de ser lidos pelo turno. NADA é apagado — limpar o campo restaura.';

-- Índice parcial: o worker e as leituras só se importam com contatos marcados.
create index if not exists idx_contacts_context_reset_at
  on contacts (organization_id, context_reset_at)
  where context_reset_at is not null;

-- ---- política de expiração por etapa do Kanban (migration 0100) ----
-- Vocabulário do TENANT: a decisão é da etapa que ele nomeou, nunca de is_won/is_lost.
alter table crm_stages
  add column if not exists resets_context boolean not null default false,
  add column if not exists context_reset_after_days integer not null default 7;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_stages_context_reset_days_range'
  ) then
    alter table crm_stages
      add constraint crm_stages_context_reset_days_range
      check (context_reset_after_days >= 0 and context_reset_after_days <= 365);
  end if;
end $$;

comment on column crm_stages.resets_context is
  'Quando true, negócio parado nesta etapa por context_reset_after_days dias tem o
   contexto do agente expirado. Padrão de fábrica false — nada expira sem escolha.';
```

Configuração org-wide (sem DDL — `organizations.settings` já é `jsonb`):

```jsonc
// organizations.settings
{
  "context_lifecycle": {
    "session_gap_hours": 6   // null desliga a fronteira de sessão
  }
}
```

Ausência da chave equivale ao default **6**. `null` explícito desliga.

---

## 4. Camada 1 — Fronteira de sessão

Arquivo novo: `lib/agent-engine/agent/fronteira-de-sessao.ts`.

```ts
/**
 * O corte é pelo SILÊNCIO, não pela idade da mensagem.
 *
 * "Últimas 6 horas" cortaria ao meio uma conversa contínua de dez horas — e
 * perder a primeira metade de um papo em andamento é pior que lembrar demais.
 * O que marca o fim de uma sessão é o intervalo entre duas mensagens
 * consecutivas: retomou depois de N horas, começou sessão nova.
 */
export function cortarNaFronteiraDeSessao<T extends { sent_at: string }>(
  /** Da mais ANTIGA para a mais nova (como sai de getLeadContext). */
  mensagens: T[],
  gapHoras: number | null,
): T[] {
  if (gapHoras === null || gapHoras <= 0 || mensagens.length < 2) return mensagens;
  const gapMs = gapHoras * 3_600_000;

  // Varre do fim para o começo: o primeiro silêncio encontrado é o mais recente,
  // e é ele que abre a sessão atual.
  for (let i = mensagens.length - 1; i > 0; i--) {
    const atual = Date.parse(mensagens[i]!.sent_at);
    const anterior = Date.parse(mensagens[i - 1]!.sent_at);
    if (Number.isNaN(atual) || Number.isNaN(anterior)) continue;
    if (atual - anterior >= gapMs) return mensagens.slice(i);
  }
  return mensagens;
}
```

**Ponto de aplicação:** `lib/agent-engine/edge/crm/get-lead-context.ts`, entre a leitura do histórico (hoje linhas 207–220) e `fitToBudget` (linha 234). A fronteira roda **antes** do orçamento de tokens, para que o corte por sessão não seja confundido com corte por budget.

O `gapHoras` chega via `LeadContextKnobs` (mesmo canal de `historyLimit`/`maxTokens`), resolvido de `organizations.settings.context_lifecycle.session_gap_hours` no início do turno.

**Invariante:** a função é pura e determinística — mesmo input, mesmo output, sem relógio. Nunca lê `Date.now()`.

---

## 5. Camada 2 — Marca de corte e leituras filtradas

Três leituras passam a respeitar `contacts.context_reset_at`. O valor é lido uma vez por turno, junto do contato.

**5.1 Mensagens** — `get-lead-context.ts`, query do histórico:

```sql
   from messages
  where organization_id = $1 and conversation_id = $2
    and direction in ('inbound', 'outbound')
    and sent_at > coalesce($4::timestamptz, '-infinity'::timestamptz)
  order by sent_at desc, id desc
  limit $3
```

**5.2 Checkpoint** — `lib/agent-engine/agent/inbound-turn.ts`, `latestCheckpoint()` (hoje linhas 431–445):

```sql
  select * from lead_checkpoints
   where organization_id = $1 and contact_id = $2
     and created_at > coalesce($3::timestamptz, '-infinity'::timestamptz)
   order by seq desc
   limit 1
```

**5.3 Estado do funil** — `lead_state` é **neutralizado em leitura**, não sobrescrito:

```ts
/** Após um corte, o estado anterior deixa de valer — sem apagar a linha. */
function estadoVigente(row: LeadStateRow | null, cutoff: string | null): LeadStateRow | null {
  if (!row || !cutoff) return row;
  return Date.parse(row.updated_at) > Date.parse(cutoff) ? row : null;
}
```

`null` faz o turno operar como `stage='new'`, `qualification={}` — que é exatamente "novo ciclo" do PRD §3.6, sem escrever nada e sem tocar no Kanban.

**Regra dura:** nenhuma dessas três leituras pode usar `context_reset_at` vindo do payload do job. O valor é lido **uma vez** de `contacts` no início do turno (`loadContextResetAt`) e o mesmo snapshot alimenta checkpoint, `lead_state` e histórico — nunca três re-leituras independentes que possam divergir se a marca mudar no meio.

---

## 6. Camada 3 — Hard reset manual

### 6.1 Endpoint

`POST /api/v1/contacts/{id}/context/hard-reset`

```jsonc
// request
{
  "confirmation": "APAGAR",        // exigido, literal
  "purge_knowledge_base": false,   // opcional, default false
  "reason": "dado de teste"        // opcional, vai pro audit
}
```

A mutação destrutiva roda em **`fn_hard_reset_contact_context`** (SECURITY DEFINER, `service_role`, TX única — mesmo padrão de `fn_lgpd_cascade_redact_contact`). A rota só faz RBAC + Zod + audit/atividade após `ok: true`. Erro no meio da RPC reverte tudo; não existe reset parcial com 500.

Ordem (RPC + envelope HTTP; `organization_id` da sessão):

1. `requireRole("manager")` — admin incluso por hierarquia.
2. Rejeita se `confirmation !== "APAGAR"` → `422 invalid_confirmation`.
3. RPC: contato inexistente → `ok:false` / `404 not_found`.
4. RPC: `agent_cases` aberto do contato — join via `agent_cases.conversation_id → conversations.contact_id` (`status not in ('resolved','cancelled')` — ver §7) → `409 open_case_blocks_reset`, com `details.case_id`.
5. RPC: job `running` do contato → `409 job_in_flight_blocks_reset` (marcar `failed` **não** para o handler em memória; esperar o turno terminar evita recriar checkpoint/estado depois do delete).
6. RPC: cancela jobs `pending` do contato (`failed` + `canceled_by_context_hard_reset`).
7. RPC: `delete` `lead_checkpoints`, `lead_state`, `lead_notes` do par org+contato.
8. RPC: se `purge_knowledge_base`, `delete` `ai_chunks` cujos `metadata->>'conversation_id'` estejam entre as conversas do contato.
9. RPC: `delete` `conversations` — cascade apaga `messages` e `conversation_notes`; zera `context_reset_at`/`context_reset_reason`.
10. Rota (após `ok`): atividade `context.reset_manual` em `crm_lead_activities` + `audit({ action: "context.reset_manual", … })`.

**Nunca tocados:** `contacts` (linha), `crm_leads`, `crm_lead_activities` (exceto a inserção do passo 10), `orders`, `org_memory_entries`, `lead_state_transitions`.

**Soft reset vs hard reset:** soft reset (marca `context_reset_at`) **não** apaga `lead_notes` — só corta o que o agente lê. Hard reset é a borracha: notas, conversa e resumo somem.

`ai_agent_runs` e `ai_invocations` referenciam mensagens/conversas com `ON DELETE SET NULL` — ficam órfãos por design, preservando telemetria e custo.

### 6.2 Desfazer a expiração automática

`DELETE /api/v1/contacts/{id}/context/cutoff` — `requireRole("manager")`, `update contacts set context_reset_at = null`, atividade `context.cutoff_cleared`, audit. É o "desfazer" do PRD §3.10 e custa uma linha.

---

## 7. Worker de expiração

`app/api/v1/cron/context-lifecycle-watcher/route.ts` — mesmo contrato dos demais crons (Bearer `INTERNAL_CRON_SECRET`|`INTERNAL_SECRET`, fail-closed, `export const dynamic = "force-dynamic"`). Cadência sugerida: **1×/hora**. Teto: **500 contatos/invocação**.

Seleção:

```sql
select distinct on (l.organization_id, l.contact_id)
       l.id as lead_id, l.contact_id, l.organization_id, l.stage_changed_at, s.name as stage_name
  from crm_leads l
  join crm_stages s on s.id = l.stage_id
  join contacts c on c.id = l.contact_id
 where s.resets_context = true
   and s.is_archived = false
   and l.contact_id is not null
   and l.stage_changed_at <= now() - make_interval(days => s.context_reset_after_days)
   and (c.context_reset_at is null or c.context_reset_at < l.stage_changed_at)
   and not exists (
     select 1 from agent_cases ac
     join conversations conv on conv.id = ac.conversation_id
      where ac.organization_id = l.organization_id
        and conv.contact_id = l.contact_id
        and ac.status not in ('resolved', 'cancelled')
   )
 order by l.organization_id, l.contact_id, l.stage_changed_at asc, l.id asc
 limit 500
```

**Join de caso aberto via `conversations`.** `agent_cases` expõe `lead_id` e `conversation_id`, não `contact_id`. O caminho seguro é `ac.conversation_id → conversations.contact_id` — `conversation_id` é `NOT NULL`; `lead_id` pode ser nulo (`ON DELETE SET NULL`) e deixaria casos órfãos de lead fora do bloqueio.

**`DISTINCT ON (organization_id, contact_id)` é obrigatório.** O índice `idx_crm_leads_org_contact` não é unique: um contato com N deals elegíveis devolveria N linhas, repetiria atividade/audit e faria o `LIMIT 500` contar deals em vez de contatos. Empate resolvido pelo `stage_changed_at` mais antigo (carência mais vencida), depois `l.id`.

**"Caso aberto" é definido por negação, de propósito.** O CHECK de `agent_cases.status` hoje aceita `awaiting_human`, `awaiting_lead`, `resolved`, `escalated` e `cancelled`. Listar os abertos pelo nome faria um status novo (adicionado depois por outra spec) nascer **fora** do bloqueio, silenciosamente — o reset passaria a apagar contexto de casos que ninguém previu. Com `not in ('resolved','cancelled')`, status novo entra bloqueando, que é o lado seguro do erro. A mesma expressão (e o mesmo join via `conversations`) vale para o hard reset (§6.1, passo 3).

Para cada linha: `update contacts set context_reset_at = now(), context_reset_reason = 'stage_policy'`, cancelar jobs pendentes do contato, inserir atividade `context.reset_auto` com `metadata.stage_name` e `metadata.after_days`, e `audit`. Side effects rodam **uma vez por contato**, não por deal.

**Idempotência:** a condição `c.context_reset_at < l.stage_changed_at` faz o contato sair do conjunto após a primeira passagem. Reprocessar não muda nada. Se o negócio voltar para a etapa depois (novo `stage_changed_at`), volta a ser elegível — que é o comportamento correto para um novo ciclo.

**Degradação:** falha do worker não corrompe nada — o agente segue lembrando. Alerta se a org tem política ativa e nenhum ciclo há >24h.

---

## 8. Ficha do cliente e aviso de atendimento anterior

Montados em `get-lead-context.ts`, junto do payload curado. Ambos entram **apenas quando há corte** (aviso) ou **sempre** (ficha).

**8.1 Ficha** — consulta única, agregada, sobre `orders`:

```sql
select count(*)::int as total,
       max(ordered_at)::text as ultimo_em,
       (array_agg(total_cents order by ordered_at desc))[1] as ultimo_valor_cents,
       (array_agg(currency   order by ordered_at desc))[1] as moeda,
       (array_agg(fulfillment_status order by ordered_at desc))[1] as ultimo_status
  from orders
 where organization_id = $1 and contact_id = $2 and is_anonymized = false
```

Renderização no contexto (pt-BR, factual, sem adjetivo):

```
Cliente: Renan (tags: atacado)
Relação: 3 pedidos · último em 12/03/2026 · R$ 480,00 · entregue
```

Contato sem pedido não gera a linha `Relação`. Contato com `is_anonymized=true` não gera ficha alguma.

**8.2 Aviso** — quando `context_reset_at is not null` **ou** a fronteira de sessão cortou ao menos uma mensagem:

```
[Houve atendimento anterior com este cliente. O conteúdo daquelas conversas não
está disponível neste turno — não afirme que é o primeiro contato, e não tente
adivinhar o que foi conversado. Se precisar de algo de lá, pergunte ao cliente.]
```

**Invariante:** nem a ficha nem o aviso podem conter texto derivado de `lead_checkpoints.rolling_summary` ou de `messages.body`. Coberto por teste de invariante.

---

## 9. UI e UX writing

Strings exatas — pt-BR, linguagem de negócio, sem jargão técnico. Nenhuma tela usa a palavra "contexto" sem explicar o que ela significa na prática.

### 9.1 Etapa do Kanban (configuração do pipeline)

> **Recomeçar o atendimento nesta etapa**
>
> ☐ Quando o negócio chegar aqui, a IA recomeça do zero
> *A IA esquece o que foi conversado, mas continua sabendo quem é o cliente e o que ele já comprou. O histórico completo continua visível para a sua equipe.*
>
> Esperar `[ 7 ]` dias antes de recomeçar
> *Tempo para o pós-venda acontecer. Se o cliente voltar antes disso, a IA ainda lembra da conversa.*

### 9.2 Memória da IA → aba *Ciclo de vida do contexto*

> **Quando a IA deve recomeçar a conversa**
>
> Recomeçar após `[ 6 ]` horas de silêncio
> *Se o cliente ficar esse tempo sem falar, a IA não relê a conversa anterior — mas continua sabendo o que ficou combinado e quem ele é. Deixe em branco para a IA sempre reler tudo.*
>
> ℹ️ *Isto não apaga nada. Sua equipe continua vendo o histórico inteiro, e o que a IA aprendeu sobre o seu negócio (Memória da IA e base de conhecimento) não é afetado.*

### 9.3 Contatos → botão e diálogo de hard reset

Botão ao lado de **Editar**, `variant="outline"`, visível para `manager`+:

> **Resetar conversa**

Diálogo:

> **Apagar o contexto deste contato**
>
> Isso apaga as mensagens, o resumo, as notas e o estado do funil da IA para **{nome}**. O contato e o negócio continuam existindo, com toda a ficha e o histórico de pedidos.
>
> **Esta ação não pode ser desfeita.**
>
> ☐ Remover também o que a IA aprendeu dessas conversas na base de conhecimento
> *Marque se estas conversas foram testes e não devem servir de referência para outros atendimentos.*
>
> Digite **APAGAR** para confirmar: `[________]`
>
> `Cancelar` · `Apagar contexto`

Erro de caso aberto:

> Existe um caso aberto para este contato. Resolva o caso antes de apagar o contexto — senão quem estiver cuidando dele perde a referência.

### 9.4 Divisor na thread do inbox

> ─────── Contexto reiniciado em 12/08/2026 · fim de ciclo ───────

Variante manual: `· reset manual por Renan Brandão`. Tooltip:

> *A IA não lê as mensagens acima. Você continua vendo tudo.*

### 9.5 RBAC no cliente

Duas entradas novas em `ACTION_MIN_ROLE` (`hooks/auth/AuthProvider.tsx:88`):

```ts
"context.reset_manual": "manager",
"context.policy_write": "admin",
```

Componentes usam `usePermission("context.reset_manual")` — nunca checagem manual de role.

---

## 10. Migrations (a tripla)

1. `supabase/migrations/20260802120000_0100_ciclo_de_vida_do_contexto.sql` — DDL de §3, idempotente (`add column if not exists`, `create index if not exists`, constraint guardada por `do $$`).
2. Apêndice em `supabase/baseline.sql`, rotulado `-- ---- ciclo de vida do contexto (migration 0100) ----`, idempotente e auto-curativo — é o que o `install.sh` e o `update.sh` do kit self-host aplicam.
3. Linha em `supabase/migrations/MANIFEST.md` descrevendo o quê e o porquê.
4. `lib/database.types.ts` regenerado (contrato de `contacts` e `crm_stages` mudou).

Sem backfill: as colunas nascem com default que reproduz o comportamento atual (`context_reset_at` nulo, `resets_context` false).

---

## 11. Plano de Validação

**Unitário (`pnpm test:unit`)**
- `cortarNaFronteiraDeSessao`: conversa contínua de 10h não é cortada; retomada após 8h corta na retomada; `null` devolve tudo; array com 0/1 mensagem; timestamp inválido não quebra; determinismo (mesmo input ⇒ mesmo output).
- `estadoVigente`: estado anterior ao corte vira `null`; posterior sobrevive; sem corte devolve como está.
- Ficha: 0 pedidos omite a linha `Relação`; contato anonimizado não gera ficha; formatação de moeda e data pt-BR.

**Invariantes (`pnpm test:db`)**
- Isolamento: política e marca da org A nunca afetam contato da org B (2 tenants).
- Idempotência do worker: rodar 2× produz 1 marca e 1 atividade.
- Não-destrutividade: após expiração automática, `count(messages)` do contato é idêntico ao de antes.
- Ficha e aviso nunca contêm substring de `rolling_summary` nem de `messages.body`.
- Hard reset preserva `contacts`, `crm_leads`, `crm_lead_activities` e `orders`; após o reset, `count(lead_notes)` do contato é 0 (notas duráveis entram na borracha — o agente as injeta no turno).
- Worker de expiração: contato com 2+ deals elegíveis gera exatamente 1 marca, 1 atividade e 1 audit.
- `baseline.sql` aplica em modos install (`ON_ERROR_STOP=1`) e update num `pgvector/pgvector:pg17` descartável.

**E2E pela tela (`pnpm test:e2e`, doutrina de QA visual)**
- Marcar uma etapa como "recomeça do zero", avançar um negócio, rodar o cron, e provar pela tela: divisor aparece na thread, histórico continua completo, atividade na timeline.
- Hard reset pelo detalhe do contato com confirmação digitada; provar que o contato continua na lista e o histórico sumiu.
- `agent` e `viewer` não veem o botão; `manager` vê.

**Prova de ponta (ambiente fresco estilo VPS)**
- Conversa real via WhatsApp: cotação dada, silêncio de 8h, retomada — o agente **não** repete o papo e **ainda sabe** a cotação (é o AC 1 + AC 2 do PRD, e o teste que reprova o desenho ingênuo de "cortar tudo em 6h").

---

## 12. Faseamento

| Fase | Entrega | Toca schema? |
|---|---|---|
| **C1** | Fronteira de sessão (função pura + aplicação + config org-wide) | não |
| **C2** | Marca de corte, leituras filtradas, hard reset manual, divisor na thread | sim (0098) |
| **C3** | Política por etapa + worker de expiração + UI da etapa | sim (0098) |
| **C4** | Ficha do cliente + aviso de atendimento anterior | não |
| **C5** | *(deferido)* card novo na recompra; purga de retenção LGPD | sim |

C1 entrega valor sozinha e sem risco de schema. C2 e C3 compartilham a migration 0100 — se forem entregues em PRs separados, a migration sai inteira em C2 e C3 apenas passa a usar as colunas.

---

## Anexos

- PRD: [`docs/prd/07-prd-gestao-contexto-agente.md`](../prd/07-prd-gestao-contexto-agente.md)
- Backlog executável: `plan/contexto/features.json`, `plan/contexto/phases.md`
- Pontos de código tocados: `lib/agent-engine/edge/crm/get-lead-context.ts` (histórico, ficha, aviso), `lib/agent-engine/agent/inbound-turn.ts` (`latestCheckpoint`), `hooks/auth/AuthProvider.tsx` (`ACTION_MIN_ROLE`), `app/app/contacts/[id]/_client.tsx` (botão), `app/app/ai/memory/` (aba de política), `app/api/v1/cron/context-lifecycle-watcher/` (worker novo)
- Padrão de referência para o diálogo destrutivo: `components/contacts/AnonymizeDialog.tsx`
- Padrão de referência para o cron: `app/api/v1/cron/snooze-watcher/route.ts`
