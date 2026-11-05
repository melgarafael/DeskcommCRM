-- manifest: **O atendente vê as conversas do próprio SETOR.** Novo valor para `organizations.settings.visibility_mode`: `own_and_sector` — o papel restrito (`agent`/`ai_operator`) passa a ver a conversa cujo `sector_id` é de um setor em que ele está vinculado (`attendant_sector_members`), inclusive as que estão com um COLEGA do setor, e segue sem ver as dos outros setores; gestor/admin/viewer continuam org-wide e o isolamento entre organizações continua sendo a primeira barreira. Função nova `fn_conversation_sector_scope()` (`stable security definer`, resolve os setores do chamador uma vez por consulta) e UMA disjunção nova em `conversations_select`. Nenhuma cláusula existente mudou, nenhuma policy de leads foi tocada e nenhuma função existente foi alterada.
--
-- ─── O defeito, medido (issue #4022) ────────────────────────────────────────
--
-- O setor decide QUEM RECEBE a conversa (`fn_channel_routing_claim` recusa
-- candidato fora da fila da conversa, migration 9062) e não QUEM A VÊ. As três
-- opções da tela de atendimento são por PESSOA:
--
--   'all' ................ vê tudo, inclusive os outros setores;
--   'own_and_unassigned' . vê as suas e a fila sem dono (o padrão);
--   'own' ................ vê só as suas.
--
-- Medido com o baseline aplicado, organização com Atacado e Financeiro, Ana
-- (Atacado) e Natália (Atacado):
--
--   'all'                 → Ana vê a conversa da Natália e a do Financeiro (5 de 5);
--   'own_and_unassigned'  → Ana vê a dela + a fila sem dono, NÃO a da Natália (2 de 5);
--   'own'                 → Ana vê só a dela (1 de 5);
--   'own_and_sector'      → antes desta migration, valor desconhecido: cai no
--                           `else false` da escada e Ana vê só a dela (1 de 5).
--
-- Ou seja: para a equipe cobrir férias e ausências, a empresa só tinha o 'all',
-- que abre o Inbox inteiro — inclusive os outros setores. É o "tudo ou nada" que
-- esta migration desfaz.
--
-- ─── A régua nova, e onde ela NÃO entra ────────────────────────────────────
--
-- A disjunção acrescentada à policy lê SÓ `conversations.sector_id` contra os
-- setores do chamador. Ela é ADITIVA: as cinco cláusulas da 9016 (plataforma,
-- org-wide, dono, fila sem dono, participante) seguem byte a byte, então tudo o
-- que era visível continua visível e nada do que era invisível vira visível por
-- outro caminho. Em particular:
--
--   · `fn_conversation_sector_scope()` só devolve linha para organização em
--     `visibility_mode = 'own_and_sector'` E para quem não é
--     viewer/manager/admin. Nas outras organizações e nos outros papéis ela
--     devolve ZERO linhas — a disjunção é falsa e a policy é a de antes;
--   · o setor vem de `attendant_sector_members`, sempre com
--     `organization_id` — e a comparação é no PAR (organização, setor), não no
--     id do setor sozinho: setor de outra organização nunca casa;
--   · `fn_user_role_in_org` é a MESMA fonte de "quem é membro" da escada
--     (`fn_user_org_ids` / `fn_support_context`). Quem não é membro não tem
--     linha em `attendant_sector_members` (a FK composta aponta para
--     `user_organizations`) e continua vendo nada.
--
-- ─── Custo: uma avaliação por consulta, não por linha ──────────────────────
--
-- A 0726 tirou a chamada por LINHA da policy (#3090). A disjunção nova é
-- avaliada no mesmo molde: a subconsulta é SEM correlação com a linha, então o
-- planejador a resolve uma vez (initplan/hashed subplan) e o filtro por linha é
-- teste de pertinência. Medido adiante, no cabeçalho do teste de invariante,
-- com o plano e o tempo da caixa de entrada.
--
-- ─── O que esta migration NÃO faz (de propósito) ───────────────────────────
--
--   · `fn_can_view_lead` e as policies de LEADS: o valor novo cai no `else
--     false` daquela escada, isto é, negócio continua "só os seus" — não é
--     tocado nesta fatia (limite explícito da issue: a régua aqui é a CONVERSA);
--   · `fn_can_view_conversation(p_org, p_assigned_to_user_id)` não é alterada e
--     continua sem conhecer o setor da linha: ela é a régua das tabelas FILHAS
--     (notas internas, rascunhos de IA, eventos de atribuição, chamados). O
--     efeito é o mesmo que o atendimento conjunto já tem desde a 9016 — quem
--     cobre o colega LÊ a conversa e as mensagens (que herdam a policy de
--     `conversations` por `exists`), e as NOTAS INTERNAS continuam fora do
--     alcance de quem não é o responsável. Nada aqui amplia leitura de nota;
--   · escrita: as policies restritivas de UPDATE/DELETE da 9016 chamam
--     `fn_can_view_conversation`, então a conversa do colega é somente leitura
--     para quem não é o responsável — o mesmo recorte do participante. Trocar o
--     dono continua sendo do dono ou de gestor+.

-- Os setores do chamador, por organização, SÓ nas organizações que ligaram o
-- modo e SÓ para o papel que o modo restringe. Zero linhas nos demais casos.
-- `stable` + `security definer` + search_path blindado, como as irmãs
-- `fn_conversation_scope` / `fn_can_view_lead`: o corpo lê
-- `attendant_sector_members` e `organizations` com as regras de membership do
-- próprio schema, independente de quem chama.
--
-- `language plpgsql` e NÃO `sql`, e a razão é a instalação: no `baseline.sql` o
-- espelho desta função entra ANTES da VARREDURA anon (que proíbe `create
-- function` depois dela) e a tabela `attendant_sector_members` só é criada no
-- apêndice da 0801/9062, MAIS ABAIXO. Corpo `sql` é resolvido na criação e
-- falharia com "relation does not exist" em toda instalação nova; corpo plpgsql
-- é resolvido na primeira execução, quando as tabelas já existem. As duas
-- pontas (migration e espelho) têm de ser idênticas — `baseline-e-cadeia` compara.
create or replace function public.fn_conversation_sector_scope()
returns table (organization_id uuid, sector_id uuid)
language plpgsql stable security definer
set search_path = public
as $$
begin
  return query
    select m.organization_id, m.sector_id
      from public.attendant_sector_members m
     where m.user_id = auth.uid()
       and public.fn_user_role_in_org(m.organization_id) is not null
       and public.fn_user_role_in_org(m.organization_id) not in ('viewer','manager','admin')
       and coalesce((select z.settings->>'visibility_mode'
                       from public.organizations z
                      where z.id = m.organization_id), 'own_and_unassigned') = 'own_and_sector';
end;
$$;

revoke all on function public.fn_conversation_sector_scope() from public, anon;
grant execute on function public.fn_conversation_sector_scope() to authenticated, service_role;

comment on function public.fn_conversation_sector_scope() is
  'Setores do chamador nas organizações em visibility_mode = own_and_sector (migration 9214). Uma linha por (organização, setor); zero linhas nos outros modos e para viewer/manager/admin. Lida por conversations_select; não concede leitura de nada por si.';

do $conversations_select_setor$ begin
  drop policy if exists "conversations_select" on public.conversations;
  create policy "conversations_select" on public.conversations
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
           select s.organization_id from public.fn_conversation_scope() s where s.org_wide_read
         )
      or (
           assigned_to_user_id = auth.uid()
           and organization_id in (select s.organization_id from public.fn_conversation_scope() s)
         )
      or (
           assigned_to_user_id is null
           and organization_id in (
                select s.organization_id from public.fn_conversation_scope() s where s.sees_unassigned
              )
         )
      or exists (
           select 1
             from public.conversation_participants cp
            where cp.conversation_id = conversations.id
              and cp.organization_id = conversations.organization_id
              and cp.user_id = auth.uid()
              and cp.left_at is null
              and not exists (
                select 1 from public.contacts pc
                 where pc.id=conversations.contact_id
                   and pc.organization_id=conversations.organization_id
                   and pc.is_personal
              )
         )
      or (
           sector_id is not null
           and (organization_id, sector_id) in (
                select s.organization_id, s.sector_id
                  from public.fn_conversation_sector_scope() s
              )
           and not exists (
                select 1 from public.contacts pc
                 where pc.id=conversations.contact_id
                   and pc.organization_id=conversations.organization_id
                   and pc.is_personal
              )
         )
    );
end $conversations_select_setor$;

notify pgrst, 'reload schema';
