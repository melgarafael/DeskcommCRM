# Fases — ciclo de vida do contexto do agente (C1–C5)

> Loop de construção do Sub-PRD 07 / Spec 16. Doutrina de DOMÍNIO soberana é o
> `CLAUDE.md` deste repo (+ `docs/specs/`). Este plano só governa PROCESSO.
> Backlog separado do `plan/` raiz, que está ocupado pelo **gov-loop** (fase G1
> ativa) — os dois não compartilham máquina nem checkpoints.
>
> Origem: investigação de agosto/2026 em que apagar fisicamente `messages`,
> `conversations`, `lead_checkpoints` e `lead_state` de um contato de teste **não**
> impediu o agente de retomar um pedido antigo. O diagnóstico revelou que memória
> do agente tem mais fontes do que a conversa, e nenhuma tinha política de
> expiração.
>
> Ordem inegociável: **o que não escreve no banco vem primeiro**. C1 é leitura
> pura e entrega valor sem migration; só C2 toca schema.

## Branch e merge

- Fases correm em `brandaorenan/gestao-contexto-agente` (branch única desta feature),
  a partir de `main` atualizada.
- Toda fase que toca schema segue a tripla: `supabase/migrations/<ts>_<NNNN>_<slug>.sql`
  + apêndice idempotente em `supabase/baseline.sql` + linha no `MANIFEST.md`
  + `lib/database.types.ts` regenerado.
- `pnpm test:db` local é obrigatório antes de PR em C2 e C3 (tocam schema e RLS).

## Princípios que valem em todas as fases

1. **Nada é apagado automaticamente.** C1 e C3 não emitem `delete`. Só o hard
   reset manual (C2) apaga, e só por ação humana confirmada.
2. **Padrão de fábrica não esquece.** `resets_context` nasce `false`; org nova se
   comporta exatamente como hoje. Nenhuma migration liga política para ninguém.
3. **O tenant fala o vocabulário dele.** Nenhuma regra deriva de `is_won`/`is_lost`.
4. **Nenhum reset toca card do Kanban.** Card é objeto de trabalho humano.
5. **Histórico do humano é intocável** fora do hard reset.

## C1 — Fronteira de sessão (leitura pura, sem schema)

Sai da fase quando:
- `cortarNaFronteiraDeSessao` existe, é pura (não lê relógio) e tem teste cobrindo
  conversa contínua longa, retomada após silêncio, `null`, e arrays degenerados.
- O intervalo é resolvido de `organizations.settings.context_lifecycle.session_gap_hours`
  com default 6 e `null` desligando.
- `getLeadContext` aplica a fronteira **antes** de `fitToBudget`.
- Nenhuma migration foi criada nesta fase.

## C2 — Marca de corte e hard reset

Sai da fase quando:
- Migration 0100 completa na tripla, aplicando em Postgres descartável nos modos
  install e update.
- As três leituras (mensagens, checkpoint, `lead_state`) respeitam `context_reset_at`,
  com `lead_state` **neutralizado em leitura**, nunca sobrescrito.
- `POST /api/v1/contacts/{id}/context/hard-reset` opera com `manager`+, confirmação
  digitada, bloqueio por caso aberto, cancelamento de jobs e audit.
- `DELETE /api/v1/contacts/{id}/context/cutoff` desfaz a expiração automática.
- Botão e diálogo em Contatos, com as strings da Spec §9.3.
- Divisor de corte visível na thread do inbox.
- Invariantes de não-destrutividade e isolamento 2-tenants verdes.

## C3 — Política por etapa e worker

Sai da fase quando:
- UI da etapa do Kanban com as strings da Spec §9.1, escrita para leigo.
- Aba *Ciclo de vida do contexto* em Memória da IA com as strings da Spec §9.2.
- `context-lifecycle-watcher` roda, é idempotente, respeita teto de 500 e pula
  contatos com caso aberto.
- Atividade `context.reset_auto` visível na timeline.
- Invariante de idempotência do worker verde.

## C4 — Ficha e aviso

Sai da fase quando:
- Ficha (identidade + relação comercial derivada de `orders`) entra no contexto.
- Aviso de atendimento anterior entra quando — e só quando — houve corte.
- Invariante: nem ficha nem aviso contêm substring de `rolling_summary` ou
  `messages.body`.
- Prova de ponta: cotação dada, silêncio de 8h, retomada — o agente não repete o
  papo e ainda sabe a cotação.

## C5 — Deferido (não entra sem novo aceite)

- Card novo no Kanban na recompra (semântica no PRD §3.6).
- Purga automática por retenção LGPD (PRD §3.12).
