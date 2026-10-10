-- 20260928150000_0478_notas_internas_realtime_e_visibilidade.sql
-- 0478 — as notas internas: o realtime que nunca chegava e a visibilidade que
-- não seguia a conversa (#1863, F1 + F2).
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- A nota interna (Onda 5.2) é o bloco de notas do atendimento: anotação de
-- procedimento interno que o cliente nunca vê. Está pronta de ponta a ponta —
-- tabela, rotas, toggle `Responder | Nota interna`, destaque amarelo, menção
-- que dispara. Faltavam duas peças, e as duas foram medidas na main.
--
-- F1 · o canal realtime da nota é uma falha MUDA.
-- `supabase_realtime` é uma lista explícita de tabelas (o `foreach` do
-- baseline). `conversation_notes` não estava em nenhuma das listas — grep
-- `conversation_notes` com `realtime` devolvia 0. O hook assina, o Supabase
-- responde `SUBSCRIBED` e nenhum evento chega: sem erro, sem aviso. Na prática
-- a anotação de um atendente só aparecia para os demais quando alguém
-- recarregava a página. O próprio repo já documentava o defeito em outro lugar,
-- no docblock de `app/api/v1/conversations/[id]/passagens/route.ts`:
--   "É o defeito vivo de `hooks/inbox/useConversationNotes.ts`: o canal assina,
--    responde `SUBSCRIBED` e não recebe nada — falha muda."
--
-- F2 · a nota não acompanhava a visibilidade da conversa.
-- `fn_can_view_conversation(p_org, p_assigned_to_user_id)` tem 21 usos e é o
-- único portão que implementa `organizations.settings.visibility_mode`
-- (`all` | `own_and_unassigned` — padrão — | `own`). A policy da nota testava
-- só `fn_user_org_ids()`, então numa organização `own_and_unassigned`:
--   · o atendente que NÃO podia abrir a conversa lia as anotações sobre ela;
--   · quem perdeu a conversa numa passagem continuava vendo as notas dela.
-- É o único ponto em que a promessa "ao passar, quem recebe é que vê" não se
-- cumpria. O molde já existia e é o mesmo que `ai_reply_drafts` usa (0420):
-- ORGANIZAÇÃO E visibilidade da conversa, com `exists` na conversa.
--
-- ─── Por que a condição é "quem vê a conversa vê a nota" e não "só o autor" ──
-- Nenhum concorrente (Zendesk, Chatwoot, ServiceNow, Intercom) restringe a
-- nota ao autor: nota que só o autor vê não transfere conhecimento. A regra
-- certa é herdada da conversa — se a conversa passou para outro atendente, a
-- nota vai junto, porque é sobre AQUELE contato. Quem é viewer/manager/admin
-- continua vendo tudo, porque a própria função já devolve `true` para eles.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
-- Sem coluna nova, sem backfill, sem dado tocado. A escrita
-- (`conversation_notes_write`) continua exigindo papel `agent` da própria
-- organização e passa a exigir TAMBÉM a visibilidade da conversa: ela é
-- `for all`, e `for all` concede SELECT — sem a mesma condição, ela anularia
-- a leitura nova (ver o ⚠️ abaixo). Idempotente nas duas pontas.

-- ─── F1 · conversation_notes entra na publicação ────────────────────────────
-- Mesmo desenho idempotente do `foreach` do baseline: checa
-- `pg_publication_tables` antes de adicionar, então aplicar duas vezes não
-- quebra e uma aplicação em banco que já tem a tabela continua correta.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_notes'
  ) then
    execute 'alter publication supabase_realtime add table public.conversation_notes';
  end if;
end $$;

comment on table public.conversation_notes is
  'Nota interna da conversa (Onda 5.2) — anotação de procedimento interno que NUNCA vai ao cliente. Realtime desde a 0478 (o canal assinava e não recebia nada); visibilidade herdada da conversa desde a 0478, igual a ai_reply_drafts.';

-- ─── F2 · a nota herda a visibilidade da conversa ───────────────────────────
-- Molde: `tenant_isolation_ai_reply_drafts_all` (baseline, linha da 0420).
-- O `c.organization_id = conversation_notes.organization_id` importa: impede
-- que uma nota aponte para conversa de outra organização mesmo se o dado
-- legado estiver sujo.
--
-- ⚠️ A policy de ESCRITA também precisa da mesma condição. Policies são OR:
-- `conversation_notes_write` é `for all`, e `for all` concede SELECT junto.
-- Deixá-la só com organização+papo faz o SELECT novo ser anulado — foi
-- exatamente o que o teste `F2: o agent da MESMA org que não é dono NÃO lê`
-- pegou em 28/09 (devolveu 1 em vez de 0). Não é "filtrado indiretamente".
drop policy if exists "conversation_notes_select" on public.conversation_notes;
create policy "conversation_notes_select" on public.conversation_notes
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

drop policy if exists "conversation_notes_write" on public.conversation_notes;
create policy "conversation_notes_write" on public.conversation_notes
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- O platform admin precisa continuar enxergando a nota de qualquer
-- organização (a política antiga tinha esse ramo explícito). Sem ele, um
-- admin de plataforma que não é membro da org sumiria da timeline — e ele
-- nunca esteve na organização nenhuma por definição.
drop policy if exists "conversation_notes_select_platform_admin" on public.conversation_notes;
create policy "conversation_notes_select_platform_admin" on public.conversation_notes
  for select using (public.fn_is_platform_admin());
