-- manifest: **Operação do dia e relatório diário salvo no CRM.** Cria `public.relatorios_operacao_diarios` (uma linha por organização e dia, único em `(organization_id, dia)`; `conteudo jsonb` guarda só FATOS não pessoais por linha — ids de conversa/contato/negócio/responsável, canal, situação, etiquetas, instantes, código do motivo da passagem, nomes de catálogo achados pela busca da IA — e NUNCA nome, telefone, @, prévia, resumo ou o termo buscado (texto do cliente), porque a cascata de anonimização da LGPD não alcança o jsonb; a tela resolve o pessoal ao vivo. Sem coluna de texto (`drop column if exists texto` limpa a versão não publicada); `gerado_por` em ('cron','usuario')), com RLS `tenant_isolation_relatorios_operacao_diarios_all` por `fn_user_org_ids()` e papel ≥ manager (o relatório reúne conversas de toda a equipe, e o escopo de visibilidade da conversa não alcança o jsonb), `authenticated` só lê e quem escreve é o servidor (cron `relatorio-operacao-diario` com `on conflict do nothing`; botão "Gerar agora" com `on conflict do update`). Cria também `public.fn_operacao_conversas_com_entrada(p_org, p_inicio, p_fim, p_limite)`, `security invoker` (a RLS de `messages`/`conversations` vale para a sessão), que devolve por conversa a primeira e a última mensagem do cliente no intervalo e se ela é NOVA (nenhuma mensagem do cliente antes do intervalo) — a contagem "conversas novas no dia" sem trazer as mensagens ao servidor. Revogada de `public`/`anon`. Idempotente; espelho no apêndice do `baseline.sql`. Prova em `tests/invariants/relatorios-operacao-diarios-isolamento.test.ts`.

-- ═══ O RELATÓRIO DIÁRIO DA OPERAÇÃO ═══
--
-- Uma linha por organização e dia LOCAL (o fuso da organização decide o dia).
-- A unicidade é a idempotência: o cron roda a cada 15 minutos e insere com
-- `on conflict do nothing`, então repetir, atrasar ou rodar em duas réplicas
-- nunca duplica. O botão "Gerar agora" regera o MESMO dia por cima.
--
-- `conteudo` é o formato `OperacaoDoDia` (`lib/operacao/tipos.ts`, `versao`
-- dentro do jsonb) passado por `congelar` (`lib/operacao/conteudo.ts`): SÓ
-- FATOS — ids (conversa, contato, negócio, responsável), canal, situação,
-- etiquetas, instantes, códigos, produtos do catálogo achados pela busca da IA
-- (nunca o TERMO buscado, que é texto do cliente). NUNCA nome,
-- telefone, @, prévia de mensagem ou resumo: a cascata de anonimização da LGPD
-- (`fn_lgpd_cascade_redact_contact`) não alcança um jsonb guardado, então ele
-- não pode ter o que ela precisaria apagar. A tela do relatório resolve o
-- pessoal AO VIVO pela RLS da sessão — contato anonimizado aparece anonimizado.
--
-- Sem coluna de texto, de propósito: um texto congelado útil teria o nome do
-- cliente, e sem nome ele não diz nada. O texto é montado na leitura.

create table if not exists public.relatorios_operacao_diarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia date not null,
  fuso text not null,
  gerado_em timestamptz not null default now(),
  gerado_por text not null,
  conteudo jsonb not null
);

-- Uma versão não publicada desta migration tinha `texto text not null` com
-- o nome dos contatos. Quem a aplicou num banco de desenvolvimento perde a
-- coluna aqui (idempotente; nenhuma instalação publicada a teve).
alter table public.relatorios_operacao_diarios drop column if exists texto;

comment on table public.relatorios_operacao_diarios is
  'Relatório diário da Operação do dia: uma linha por organização e dia local, com SÓ fatos não pessoais em conteudo (ids, canal, situação, etiquetas, instantes, códigos, nomes de produto do catálogo). Nome, telefone e resumo são lidos ao vivo na tela. Quem escreve é o servidor (cron relatorio-operacao-diario e o botão Gerar agora); a sessão só lê, com papel manager ou acima.';

-- O drop e o add num bloco só: um bloco DO é uma instrução, então o `update.sh`
-- (que reaplica o baseline sem ON_ERROR_STOP) nunca deixa a tabela entre as
-- duas, sem a constraint.
do $$
begin
  alter table public.relatorios_operacao_diarios
    drop constraint if exists relatorios_operacao_diarios_gerado_por_check;
  alter table public.relatorios_operacao_diarios
    add constraint relatorios_operacao_diarios_gerado_por_check check (gerado_por in ('cron', 'usuario'));
end $$;

-- ⚠️ É A IDEMPOTÊNCIA DO CRON, não otimização. Dados duplicados (impossíveis
-- enquanto a tabela nasceu com a constraint) seriam podados antes de criá-la.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'relatorios_operacao_diarios_org_dia_key'
       and conrelid = 'public.relatorios_operacao_diarios'::regclass
  ) then
    delete from public.relatorios_operacao_diarios a
     using public.relatorios_operacao_diarios b
     where a.organization_id = b.organization_id
       and a.dia = b.dia
       and a.gerado_em < b.gerado_em;
    alter table public.relatorios_operacao_diarios
      add constraint relatorios_operacao_diarios_org_dia_key unique (organization_id, dia);
  end if;
end $$;

alter table public.relatorios_operacao_diarios enable row level security;

-- GRANTS EXPLÍCITOS. O default ACL do Supabase concede tudo a anon e
-- authenticated em toda tabela nova; aqui a sessão só lê.
revoke all on public.relatorios_operacao_diarios from anon;
revoke all on public.relatorios_operacao_diarios from authenticated;
grant select on public.relatorios_operacao_diarios to authenticated;
grant select, insert, update, delete on public.relatorios_operacao_diarios to service_role;

-- Tenant + papel: o relatório reúne as conversas da equipe inteira, então a
-- régua de visibilidade de uma conversa (`fn_can_view_conversation`) não
-- protegeria o jsonb. Manager ou acima, como a tela.
drop policy if exists tenant_isolation_relatorios_operacao_diarios_all on public.relatorios_operacao_diarios;
create policy tenant_isolation_relatorios_operacao_diarios_all on public.relatorios_operacao_diarios
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- ═══ AS CONVERSAS COM MENSAGEM DO CLIENTE NUM INTERVALO ═══
--
-- `nova` = nenhuma mensagem do cliente ANTES do intervalo: é a primeira
-- conversa daquela pessoa naquele número. `security invoker`: chamada pela
-- sessão, a RLS de `messages` e `conversations` vale (inclusive o escopo de
-- visibilidade); chamada pelo cron, o filtro `organization_id = p_org` escrito
-- é o que isola. Grupo fica de fora.
create or replace function public.fn_operacao_conversas_com_entrada(
  p_org uuid,
  p_inicio timestamptz,
  p_fim timestamptz,
  p_limite integer default 5000
)
returns table (
  conversation_id uuid,
  channel text,
  primeira_entrada timestamptz,
  ultima_entrada timestamptz,
  entradas integer,
  nova boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with do_dia as (
    select m.conversation_id,
           min(m.sent_at) as primeira,
           max(m.sent_at) as ultima,
           count(*)::integer as n
      from public.messages m
     where m.organization_id = p_org
       and m.direction = 'inbound'
       and m.sent_at >= p_inicio
       and m.sent_at < p_fim
     group by m.conversation_id
  )
  select d.conversation_id,
         c.channel,
         d.primeira,
         d.ultima,
         d.n,
         not exists (
           select 1
             from public.messages p
            where p.conversation_id = d.conversation_id
              and p.organization_id = p_org
              and p.direction = 'inbound'
              and p.sent_at < p_inicio
         ) as nova
    from do_dia d
    join public.conversations c
      on c.id = d.conversation_id
     and c.organization_id = p_org
   where not c.is_group
   order by d.primeira
   limit greatest(1, least(coalesce(p_limite, 5000), 20000));
$$;

revoke execute on function public.fn_operacao_conversas_com_entrada(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.fn_operacao_conversas_com_entrada(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;

comment on function public.fn_operacao_conversas_com_entrada(uuid, timestamptz, timestamptz, integer) is
  'Operação do dia: por conversa (sem grupo), a primeira e a última mensagem do cliente no intervalo [p_inicio, p_fim) e se ela é nova (nenhuma mensagem do cliente antes). security invoker: a RLS da sessão vale.';
