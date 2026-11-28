-- manifest: **A quarentena do filtro de spam da entrada existe no banco.** Uma tabela nova e aditiva, `quarentena_de_entrada`, que guarda a mensagem suspeita por `message_id` ÚNICO: a mensagem continua em `messages` (nada é apagado, nada é movido) e a linha só diz que ela não acorda ninguém até uma pessoa liberar; `veredito`, `confianca` e os NOMES dos sinais léxicos ficam como prova de que a triagem foi feita, e `status`/`liberada_por`/`liberada_em` registram a liberação humana. `fn_quarentena_resumo` devolve `em_quarentena`, `liberadas` e `perdidas` (= linhas de quarentena sem a mensagem, o contador de perda, que tem de ser zero). Nenhuma coluna removida, nenhum dado tocado, nenhum default ligado. Idempotente.

-- ═══ #4026 — A QUARENTENA DE ENTRADA ═══
--
-- A REGRA DURA: nada é descartado. A mensagem já está em `messages` quando esta
-- linha nasce, e esta tabela NÃO a apaga, não a esconde do banco e não muda o
-- status dela. O que ela muda é a CONSEQUÊNCIA: enquanto `status =
-- 'em_quarentena'`, a mensagem não abriu demanda, não acordou a IA, não disparou
-- ligação, notificação nem automação — e uma pessoa pode liberar, daí os efeitos
-- normais rodam atrasados.
--
-- `message_id` é ÚNICO: reentrega da mesma mensagem (o provedor reenvia, o job
-- reprocessa) não abre duas linhas de quarentena nem pede duas liberações.
create table if not exists public.quarentena_de_entrada (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  message_id uuid not null,
  channel_session_id uuid,
  veredito text not null,
  confianca numeric(4, 3) not null,
  sinais jsonb not null default '[]'::jsonb,
  status text not null default 'em_quarentena',
  liberada_por uuid,
  liberada_em timestamptz,
  created_at timestamptz not null default now(),
  constraint quarentena_status_check check (status in ('em_quarentena', 'liberada')),
  constraint quarentena_confianca_check check (confianca >= 0 and confianca <= 1),
  constraint quarentena_liberada_tem_quem check (
    (status = 'em_quarentena' and liberada_por is null and liberada_em is null)
    or (status = 'liberada' and liberada_por is not null and liberada_em is not null)
  )
);

create unique index if not exists quarentena_uma_por_mensagem
  on public.quarentena_de_entrada (message_id);

create index if not exists quarentena_aberta_da_org
  on public.quarentena_de_entrada (organization_id, created_at desc)
  where status = 'em_quarentena';

alter table public.quarentena_de_entrada enable row level security;

revoke all on public.quarentena_de_entrada from public, anon, authenticated, service_role;
grant select on public.quarentena_de_entrada to authenticated;
grant select, insert, update, delete on public.quarentena_de_entrada to service_role;

-- Visível para quem ATENDE (é triagem de caixa, não relatório): o `agent` vê a
-- fila e sabe o que está retido. A escrita é da rota, com service role.
drop policy if exists tenant_isolation_quarentena_select on public.quarentena_de_entrada;
create policy tenant_isolation_quarentena_select on public.quarentena_de_entrada
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

comment on table public.quarentena_de_entrada is
  'Mensagem de entrada retida pelo filtro de spam (#4026). A mensagem continua em messages — nada é descartado. Em quarentena, não abre demanda, não acorda IA, não dispara ligação/notificação/automação; a liberação humana roda os efeitos normais.';

-- ═══ A pergunta que a rota e o teste fazem ═══
--
-- Sem esta função, a rota teria de ler N linhas para somar, e o teste da "perda
-- zero" teria de confiar na FK. `security definer` + `search_path` fixo, execute
-- só para `service_role`: é contador de operação, não API pública.

-- `perdidas` é o contador de perda: linha de quarentena cuja mensagem não está
-- mais em `messages`. Tem de ser 0 sempre — é o invariante da issue, medido.
create or replace function public.fn_quarentena_resumo(p_org uuid)
returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'em_quarentena', count(*) filter (where q.status = 'em_quarentena'),
    'liberadas', count(*) filter (where q.status = 'liberada'),
    'perdidas', count(*) filter (where m.id is null)
  )
  from public.quarentena_de_entrada q
  left join public.messages m on m.id = q.message_id
 where q.organization_id = p_org;
$$;

revoke execute on function public.fn_quarentena_resumo(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_quarentena_resumo(uuid) to service_role;

notify pgrst, 'reload schema';
