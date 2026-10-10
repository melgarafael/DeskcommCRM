-- 0217_relatorio_de_atividades — o que aconteceu na operação num período.
--
-- ## Por que uma função e não uma query na rota
--
-- `crm_lead_activities` é o barramento da vida do lead: hoje ele só é lido POR
-- NEGÓCIO (`/leads/[id]/timeline`) e POR CONTATO (`/contacts/[id]/timeline`).
-- Perguntar "o que a equipe fez esta semana" obrigava a abrir negócio por
-- negócio. A leitura no eixo do PERÍODO é agregação — total, por ator, por tipo
-- e por dia —, e agregação puxada para o Node significa trazer todas as linhas
-- da janela pela rede para contá-las em JavaScript. Numa VPS de 2 GB isso é o
-- que derruba o banco: a contagem tem de acontecer onde os dados estão.
--
-- ## Escopo = a própria RLS (SECURITY INVOKER, como a 0037/0133)
--
-- A policy `crm_lead_activities_select` (0042) já herda a visibilidade do
-- negócio-pai via `fn_can_view_lead`. Rodando como INVOKER, o `agent` em modo
-- 'own' vê só as atividades dos negócios dele e viewer/manager/admin veem a org
-- inteira — sem uma segunda checagem paralela que possa divergir da primeira.
-- Promover isto a SECURITY DEFINER "para simplificar" vazaria entre inquilinos;
-- é o que `tests/invariants/relatorio-de-atividades.test.ts` guarda.
--
-- ## O fuso é PARÂMETRO, não `now()` do servidor
--
-- A série diária agrupada em UTC joga a atividade das 21h de Brasília no dia
-- seguinte — o relatório diria que a equipe trabalhou num dia em que ninguém
-- trabalhou. O fuso vem do navegador de quem lê e entra como `p_tz`.
--
-- Idempotente (create index if not exists / create or replace), portável em
-- psql puro (sem BEGIN/COMMIT, sem temp tables).

-- A janela é (organization_id, performed_at): os três índices existentes lideram
-- por org mas seguem com contact_id/lead_id/type, então nenhum deles serve a um
-- recorte de período org-wide sem varrer a org inteira.
create index if not exists idx_lead_activities_org_perf
  on public.crm_lead_activities (organization_id, performed_at desc);

-- Agregação única (total + por ator + por tipo + série diária + as N linhas mais
-- recentes) → jsonb. `stable`: só lê. Janela semiaberta [p_from, p_to).
--
-- NOMES não saem daqui: `auth.users` não é legível por `authenticated`, e o
-- enriquecimento (nome da pessoa, nome do agente) já tem caminho na rota. A
-- função devolve IDENTIFICADORES; quem sabe traduzir identificador em nome é a
-- camada que também sabe degradar quando o nome falta.
create or replace function public.fn_activity_report(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'UTC',
  p_limit int default 200
) returns jsonb
language sql stable
set search_path = public
as $$
  with janela as (
    select
      a.id,
      a.type,
      a.actor_kind,
      a.performed_by_user_id,
      a.actor_agent_id,
      a.performed_at,
      a.reason,
      a.lead_id,
      a.contact_id
    from public.crm_lead_activities a
    where a.organization_id = p_org
      and a.performed_at >= p_from
      and a.performed_at <  p_to
  )
  select jsonb_build_object(
    'total', (select count(*) from janela),
    -- QUEM fez. Agrupa pela tripla (tipo de ator, pessoa, agente) porque duas
    -- pessoas diferentes com o mesmo `actor_kind` são duas linhas, não uma.
    'by_actor', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'actor_kind', g.actor_kind,
          'user_id', g.performed_by_user_id,
          'agent_id', g.actor_agent_id,
          'count', g.c
        ) order by g.c desc, coalesce(g.actor_kind, 'zzz')
      )
      from (
        select actor_kind, performed_by_user_id, actor_agent_id, count(*) as c
        from janela
        group by 1, 2, 3
      ) g
    ), '[]'::jsonb),
    -- O QUE foi feito. O tipo cru; o rótulo legível é do TypeScript
    -- (`ACTIVITY_LABELS`), fonte única de escrita e leitura.
    'by_type', coalesce((
      select jsonb_agg(
        jsonb_build_object('type', g.type, 'count', g.c) order by g.c desc, g.type
      )
      from (select type, count(*) as c from janela group by 1) g
    ), '[]'::jsonb),
    -- QUANDO. Dias sem atividade entram com zero — um buraco no gráfico é a
    -- informação (a operação parou), e omitir a linha esconde justamente isso.
    'daily', coalesce((
      select jsonb_agg(
        jsonb_build_object('date', to_char(d.dia, 'YYYY-MM-DD'), 'count', coalesce(c.n, 0))
        order by d.dia
      )
      from generate_series(
             date_trunc('day', p_from at time zone p_tz),
             date_trunc('day', (p_to - interval '1 microsecond') at time zone p_tz),
             interval '1 day'
           ) as d(dia)
      left join (
        select date_trunc('day', performed_at at time zone p_tz) as dia, count(*) as n
        from janela
        group by 1
      ) c on c.dia = d.dia
    ), '[]'::jsonb),
    -- A LISTA, limitada. O relatório não é a timeline: quem quer o histórico
    -- inteiro de um negócio abre o negócio, e é para lá que cada linha aponta.
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'type', i.type,
          'performed_at', i.performed_at,
          'actor_kind', i.actor_kind,
          'user_id', i.performed_by_user_id,
          'agent_id', i.actor_agent_id,
          'reason', i.reason,
          'lead_id', i.lead_id,
          'lead_title', i.lead_title,
          'contact_id', i.contact_id,
          -- Os TRÊS campos crus, não um rótulo pronto: como esta pessoa se chama
          -- na tela é decisão de `lib/contacts/rotulo-do-contato.ts`, e a cadeia
          -- já divergiu em seis arquivos uma vez.
          'contact_display_name', i.contact_display_name,
          'contact_name', i.contact_name,
          'contact_phone', i.contact_phone
        ) order by i.performed_at desc, i.id
      )
      from (
        select
          j.*,
          l.title as lead_title,
          ct.display_name as contact_display_name,
          ct.name as contact_name,
          ct.phone_number as contact_phone
        from janela j
        left join public.crm_leads l on l.id = j.lead_id
        left join public.contacts ct on ct.id = j.contact_id
        order by j.performed_at desc, j.id
        limit greatest(p_limit, 0)
      ) i
    ), '[]'::jsonb),
    -- A lista foi cortada? Sem isto, um período movimentado pareceria calmo.
    'items_truncated', (select count(*) from janela) > greatest(p_limit, 0)
  );
$$;

-- Função nova em `public` nasce EXPOSTA por DUAS origens (CLAUDE.md, doutrina de
-- migrations §9): o `GRANT ALL ON FUNCTIONS TO anon` do baseline e o grant a
-- PUBLIC que o Postgres dá a toda função. Tratar só uma deixa a RPC alcançável
-- pela anon key, que vai para o browser.
revoke all on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int) from public;
revoke execute on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int) from anon;
grant execute on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int)
  to authenticated, service_role;
