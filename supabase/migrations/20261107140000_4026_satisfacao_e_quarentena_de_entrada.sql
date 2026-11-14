-- manifest: **A pesquisa de satisfação do encerramento e a quarentena de entrada existem no banco.** Duas tabelas novas e aditivas. `satisfacao_do_atendimento` guarda o pedido feito ao encerrar (um pedido ABERTO por conversa, por índice parcial único), a nota 1–5 que voltou e o desfecho `sem_nota` do pedido vencido — sem nota não há linha de nota respondida, e a leitura é restrita a `manager`+ pela policy (média nunca por conversa para quem não gerencia). `quarentena_de_entrada` guarda a mensagem suspeita por `message_id` ÚNICO: a mensagem continua em `messages` (nada é apagado, nada é movido) e a linha só diz que ela não acorda ninguém até uma pessoa liberar. `fn_satisfacao_resumo` (média/contagem) e `fn_satisfacao_fechar_vencidas` (pedido vencido vira `sem_nota`) poupam duas leituras de N linhas na rota; `fn_quarentena_resumo` devolve `perdidas` = linhas de quarentena sem a mensagem, que é o contador de perda e tem de ser zero. Nenhuma coluna removida, nenhum dado tocado, nenhum default ligado. Idempotente.

-- ═══ #4023 — A PESQUISA DE SATISFAÇÃO DO ENCERRAMENTO ═══
--
-- O gatilho `conversation.closed` já existe desde a migration 9212: fechar a
-- conversa passou a ser fato no `event_log`. O que faltava era o desfecho do
-- pedido — e o desfecho precisa de lugar próprio, porque a nota é do PEDIDO (a
-- pergunta feita naquele encerramento), não do contato: o mesmo cliente fecha
-- dez atendimentos e cada um tem a sua nota.
--
-- `status` tem três valores, e o terceiro é o que impede a conta de mentir:
-- `aguardando` (perguntou e o cliente ainda não respondeu), `respondida` (a
-- mensagem de 1 a 5 chegou e a nota é dela) e `sem_nota` (a janela venceu sem
-- resposta). Quem calcula média usa só `respondida`; quem conta pedidos usa as
-- três. Tratar "sem resposta" como nota zero faria a média despencar por
-- silêncio, que é o defeito clássico de CSAT.
create table if not exists public.satisfacao_do_atendimento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'aguardando',
  nota smallint,
  perguntado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  respondido_em timestamptz,
  mensagem_da_resposta_id uuid,
  created_at timestamptz not null default now(),
  constraint satisfacao_status_check check (status in ('aguardando', 'respondida', 'sem_nota')),
  constraint satisfacao_nota_check check (nota is null or (nota >= 1 and nota <= 5)),
  -- A nota só existe quando a resposta existe. Sem esta constraint, um UPDATE
  -- parcial deixaria `respondida` sem nota e a média dividiria por ela.
  constraint satisfacao_nota_e_do_respondido check (
    (status = 'respondida' and nota is not null and respondido_em is not null)
    or (status <> 'respondida' and nota is null and respondido_em is null)
  )
);

-- UM pedido aberto por conversa. É o que garante "pergunta UMA vez": fechar de
-- novo a mesma conversa (ou o lote fechando em paralelo) bate no índice e não
-- manda a segunda mensagem — a guarda é do banco, não da ordem das chamadas.
create unique index if not exists satisfacao_um_pedido_aberto_por_conversa
  on public.satisfacao_do_atendimento (conversation_id)
  where status = 'aguardando';

create index if not exists satisfacao_da_org_no_periodo
  on public.satisfacao_do_atendimento (organization_id, perguntado_em desc);

-- A varredura de vencidos procura exatamente `aguardando` com `expira_em` no
-- passado, em todas as organizações (ou numa só).
create index if not exists satisfacao_aguardando_vencendo
  on public.satisfacao_do_atendimento (expira_em)
  where status = 'aguardando';

alter table public.satisfacao_do_atendimento enable row level security;

revoke all on public.satisfacao_do_atendimento from public, anon, authenticated, service_role;
grant select on public.satisfacao_do_atendimento to authenticated;
grant select, insert, update, delete on public.satisfacao_do_atendimento to service_role;

-- A NOTA É DE QUEM GERENCIA. Não é a tela que esconde: um `agent` que peça a
-- tabela direto pelo PostgREST com o token dele casa ZERO linhas. Quem responde
-- pela média é a rota `/api/v1/metrics/satisfacao`, com piso `manager`.
drop policy if exists satisfacao_so_quem_gerencia_select on public.satisfacao_do_atendimento;
create policy satisfacao_so_quem_gerencia_select on public.satisfacao_do_atendimento
  for select to authenticated
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_user_role_in_org(organization_id) in ('manager', 'admin')
    )
  );

comment on table public.satisfacao_do_atendimento is
  'Um pedido de nota 1-5 por encerramento de atendimento (#4023). status aguardando → respondida (nota) ou sem_nota (janela vencida). Um pedido ABERTO por conversa. Leitura só manager+ (a média não é por conversa para quem não gerencia).';
comment on column public.satisfacao_do_atendimento.expira_em is
  'Fim da janela de resposta. Vencido, o pedido vira sem_nota por fn_satisfacao_fechar_vencidas — nunca nota zero.';
comment on column public.satisfacao_do_atendimento.mensagem_da_resposta_id is
  'A mensagem de ENTRADA que trouxe o 1-5. Sem FK de propósito: a resposta é dado de pesquisa e a mensagem pode ser podada pela retenção da conversa; perder a referência não pode derrubar o pedido já respondido.';

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

-- ═══ As perguntas que a rota e o teste fazem ═══
--
-- Sem estas três funções, a rota teria de ler N linhas para somar, e o teste da
-- "perda zero" teria de confiar na FK. `security definer` + `search_path` fixo,
-- execute só para `service_role`: são contadores de operação, não API pública.

create or replace function public.fn_satisfacao_fechar_vencidas(p_org uuid default null)
returns integer language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_fechados integer;
begin
  update public.satisfacao_do_atendimento
     set status = 'sem_nota'
   where status = 'aguardando'
     and expira_em < now()
     and (p_org is null or organization_id = p_org);
  get diagnostics v_fechados = row_count;
  return v_fechados;
end $$;

create or replace function public.fn_satisfacao_resumo(
  p_org uuid,
  p_de timestamptz default null,
  p_ate timestamptz default null
) returns jsonb language sql security definer
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'respostas', count(*) filter (where status = 'respondida'),
    'pedidos', count(*),
    'sem_nota', count(*) filter (where status = 'sem_nota'),
    'aguardando', count(*) filter (where status = 'aguardando'),
    'media', round(avg(nota) filter (where status = 'respondida'), 2),
    'notas', coalesce(
      jsonb_object_agg(nota::text, quantidade) filter (where nota is not null),
      '{}'::jsonb
    )
  )
  from (
    select s.status, s.nota,
           count(*) over (partition by s.nota) as quantidade
      from public.satisfacao_do_atendimento s
     where s.organization_id = p_org
       and (p_de is null or s.perguntado_em >= p_de)
       and (p_ate is null or s.perguntado_em < p_ate)
  ) t;
$$;

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

revoke execute on function public.fn_satisfacao_fechar_vencidas(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.fn_satisfacao_resumo(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.fn_quarentena_resumo(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_satisfacao_fechar_vencidas(uuid) to service_role;
grant execute on function public.fn_satisfacao_resumo(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.fn_quarentena_resumo(uuid) to service_role;

notify pgrst, 'reload schema';
