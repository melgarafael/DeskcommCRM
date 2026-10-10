-- 0419 — rascunho sugerido por integração na conversa (issue #1611)
--
-- A mensagem ao cliente precisa sair de uma PESSOA, mas quem sabe o que dizer é
-- outro sistema (ERP que sabe que a cobrança venceu, documento faltando…).
-- Hoje a integração só tem duas saídas ruins: enviar por token (a mensagem
-- aparece como "Sistema", sem pessoa decidindo) ou copiar-e-colar.
--
-- Esta tabela guarda o TEXTO SUGERIDO no servidor. Quem tem token da
-- organização cria; a caixa de entrada abre por link com o texto no campo e o
-- aviso de origem; NADA é enviado sem o clique de quem atende. O link nunca
-- carrega o texto (`?texto=` iria para proxy, histórico do navegador e relatório
-- de erro — e viraria engenharia social contra o atendente).
--
-- Campos: org + conversa + corpo + origem + quem criou (token) + validade +
-- quem consumiu. `consumed_at` é o "já usado" da régua de leitura.
create table if not exists public.conversation_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  body text not null,
  source text not null default 'integracao',
  created_by_api_token_id uuid references public.api_tokens (id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint conversation_drafts_body_check
    check (char_length(body) >= 1 and char_length(body) <= 4096)
);

create index if not exists conversation_drafts_conversation
  on public.conversation_drafts (organization_id, conversation_id, created_at desc);

-- RLS: organização + papel + VISIBILIDADE DA CONVERSA, por operação (o molde
-- de `passagens_de_atendimento` e `ai_reply_drafts`). Cada condição fecha uma
-- porta: `fn_user_org_ids` — o vizinho não lê; `fn_role_at_least('agent')` —
-- `viewer` não envia, então não lê nem consome o texto que outro sistema
-- escreveu PARA o cliente; `fn_can_view_conversation` — em `visibility_mode =
-- 'own'` o atendente não lê o rascunho de uma conversa que não é dele.
-- Quem escreve pela SESSÃO: a rota de criação (INSERT, sem token — a origem de
-- token é só do service role) e o consumo (UPDATE de uma linha ainda não usada,
-- que só pode virar "usada por MIM"). DELETE não tem caminho de sessão: quem
-- apaga é o trigger definer da LGPD. `for all` só-tenancy deixava um `viewer`
-- escrever e apagar pelo PostgREST (gate `0150` de rbac-config-ia-canais).
alter table public.conversation_drafts enable row level security;

revoke all on public.conversation_drafts from anon, authenticated;
grant select, insert, update on public.conversation_drafts to authenticated;
grant all on public.conversation_drafts to service_role;

drop policy if exists tenant_isolation_conversation_drafts_all on public.conversation_drafts;
drop policy if exists conversation_drafts_select on public.conversation_drafts;
create policy conversation_drafts_select
  on public.conversation_drafts
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.conversations c
       where c.organization_id = conversation_drafts.organization_id
         and c.id = conversation_drafts.conversation_id
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

drop policy if exists conversation_drafts_insert on public.conversation_drafts;
create policy conversation_drafts_insert
  on public.conversation_drafts
  for insert to authenticated
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and created_by_api_token_id is null
    and exists (
      select 1 from public.conversations c
       where c.organization_id = conversation_drafts.organization_id
         and c.id = conversation_drafts.conversation_id
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

drop policy if exists conversation_drafts_update on public.conversation_drafts;
create policy conversation_drafts_update
  on public.conversation_drafts
  for update to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and consumed_at is null
    and exists (
      select 1 from public.conversations c
       where c.organization_id = conversation_drafts.organization_id
         and c.id = conversation_drafts.conversation_id
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and consumed_at is not null
    and consumed_by_user_id = (select auth.uid())
  );

-- LGPD: a anonimização do contato apaga os rascunhos das conversas dele. O
-- `body` é o texto escrito PARA a pessoa ("Oi Maria, seu boleto de R$ 320
-- venceu") e a tabela não tem FK para `contacts`, então nem a cascata nem o
-- invariante de cascata a enxergam. Apagar, e não redigir: o rascunho é uma
-- proposta que ninguém enviou (o que foi enviado está em `messages`, que a
-- cascata já redige), e o que houve de operação fica no audit
-- (`conversation.draft_created` / `draft_used`). Trigger na transição
-- `is_anonymized false → true`, no molde de trg_redigir_tarefas_ao_anonimizar.
create or replace function public.fn_apagar_rascunhos_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.conversation_drafts
   where organization_id = new.organization_id
     and conversation_id in (
       select id from public.conversations
        where organization_id = new.organization_id
          and contact_id = new.id
     );
  return new;
end;
$$;

revoke execute on function public.fn_apagar_rascunhos_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_apagar_rascunhos_do_contato_anonimizado() to service_role;

drop trigger if exists trg_apagar_rascunhos_ao_anonimizar on public.contacts;
create trigger trg_apagar_rascunhos_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_apagar_rascunhos_do_contato_anonimizado();
