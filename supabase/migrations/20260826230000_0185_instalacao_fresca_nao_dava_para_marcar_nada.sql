-- ============================================================================
-- 0185 — INSTALAÇÃO FRESCA ABRIA A AGENDA E NÃO DAVA PARA MARCAR NADA
--
-- Zero `INSERT` em `calendar_event_types` em todo o repo — medido em `lib/`,
-- `app/`, `scripts/` e `supabase/`, com controle positivo (a mesma sonda contra
-- `crm_stages` acha 3 lugares no SQL e 31 no TypeScript). O vocabulário de
-- categorias existe desde a 0177 e ninguém escreve linha nenhuma.
--
-- E não dá erro: a grade vazia é indistinguível de "ninguém marcou hoje". Quem
-- instala numa VPS abre a Agenda, vê uma semana em branco e não tem o que
-- clicar — sem mensagem, sem próximo passo. É o caso P0 da doutrina de QA
-- Visual e é o item 7 do pedido do dono do produto.
--
-- ─── Por que TRIGGER e BACKFILL, e não um só ─────────────────────────────
-- Medido: o baseline NUNCA semeia organização que ainda não existe. O que ele
-- faz é `insert ... select from public.organizations` — backfill dos clones de
-- hoje. O único mecanismo que alcança organização FUTURA é trigger em
-- `organizations`, e há exatamente um no schema: `trg_seed_default_pipeline_for_org`.
--
-- Só backfill deixaria a segunda organização que o dono criar amanhã com a
-- agenda vazia. Só trigger deixaria sem nada todo clone que já instalou. Os dois
-- juntos são o que a doutrina de migrations deste repo pede quando o efeito vale
-- para o passado e para o futuro.
--
-- ─── O que se semeia, e por que NEUTRO ───────────────────────────────────
-- Três tipos que servem a qualquer negócio: Consulta, Reunião e Atendimento.
--
-- Não semeio por nicho AQUI, e a razão é medida: o nicho não é persistido em
-- lugar nenhum. `escolherPacotePorTexto()` roda em memória no passo do funil e o
-- resultado morre ali — o que fica gravado em `onboarding_state.funil` é
-- `{pipeline_id, origem, etapas}`, sem o id do pacote. Um trigger no INSERT da
-- organização roda antes de existir qualquer texto para inferir: o nome da
-- organização é tudo o que há, e `welcome.o_que_faz` ainda não foi preenchido.
--
-- E há um segundo argumento, que o maestro mediu e que sobrevive à mudança do
-- instalador: `scripts/bootstrap-owner.ts` NÃO é invocado pelo `install.sh` do
-- kit nem por script do `package.json`. Ninguém sabe com certeza QUEM cria a
-- organização numa VPS fresca. Semear por script exigiria acertar o caminho;
-- semear por TRIGGER pega qualquer caminho que seja um INSERT de verdade.
--
-- Isto é o PISO, não o teto. O enriquecimento por nicho — que é o que o item 7
-- pede de verdade — vive onde o nicho EXISTE, vivo, em
-- `app/actions/onboarding/montarQuadro.ts`, e entra em commit próprio. Os dois
-- não competem: este garante que dá para marcar; aquele faz a clínica ver
-- "Retorno" e a imobiliária ver "Visita".
--
-- ─── `on conflict do nothing`, nunca `do update` ─────────────────────────
-- O `update.sh` re-aplica o `baseline.sql` inteiro a cada atualização. Com
-- `do update`, o tipo que o dono JÁ editou — renomeado, com outra duração —
-- seria sobrescrito a cada versão do produto, em silêncio. `do nothing` é a
-- diferença entre semear e mandar.
--
-- ─── `default_owner_user_id` fica NULL, e é deliberado ───────────────────
-- O trigger dispara no INSERT de `organizations`, e `scripts/bootstrap-owner.ts`
-- só escreve em `user_organizations` DEPOIS. Não há a quem apontar; a FK é
-- `on delete set null` e aceita.
--
-- Aditiva e idempotente: função nova, trigger novo, e um backfill guardado por
-- `not exists`. Nenhuma linha existente muda.
-- ============================================================================

create or replace function public.fn_semear_tipos_de_agendamento(p_organization_id uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_criados integer := 0;
  r record;
begin
  for r in
    select * from (values
      ('Consulta',    'consulta',    'consulta', 30, 1000::numeric),
      ('Reunião',     'reuniao',     'reuniao',  30, 2000::numeric),
      ('Atendimento', 'atendimento', 'outro',    30, 3000::numeric)
    ) as t(nome, slug, categoria, duracao, posicao)
  loop
    insert into public.calendar_event_types
      (organization_id, name, slug, category, duration_minutes, position)
    values
      (p_organization_id, r.nome, r.slug, r.categoria, r.duracao, r.posicao)
    on conflict (organization_id, slug) do nothing;

    if found then
      v_criados := v_criados + 1;
    end if;
  end loop;

  return v_criados;
end;
$$;

create or replace function public.fn_semear_tipos_de_agendamento_na_org_nova()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.fn_semear_tipos_de_agendamento(new.id);
  return new;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o INSERT, e a de seed é
-- chamada por ela e pelo backfill — nenhum dos dois passa pelo PostgREST.
revoke execute on function public.fn_semear_tipos_de_agendamento(uuid) from public, anon, authenticated;
revoke execute on function public.fn_semear_tipos_de_agendamento_na_org_nova() from public, anon, authenticated;
grant  execute on function public.fn_semear_tipos_de_agendamento(uuid) to service_role;
grant  execute on function public.fn_semear_tipos_de_agendamento_na_org_nova() to service_role;

drop trigger if exists trg_semear_tipos_de_agendamento on public.organizations;
create trigger trg_semear_tipos_de_agendamento
  after insert on public.organizations
  for each row
  execute function public.fn_semear_tipos_de_agendamento_na_org_nova();

-- Backfill: os clones que JÁ instalaram. Guardado por `not exists` para o
-- `update.sh` poder re-aplicar sem duplicar e sem tocar em quem já editou.
do $$
declare o record;
begin
  for o in
    select id from public.organizations
     where not exists (
       select 1 from public.calendar_event_types t where t.organization_id = organizations.id
     )
  loop
    perform public.fn_semear_tipos_de_agendamento(o.id);
  end loop;
end
$$;

comment on function public.fn_semear_tipos_de_agendamento(uuid) is
  'O PISO da agenda: três tipos neutros (Consulta, Reunião, Atendimento) para que instalação fresca tenha o que marcar. Não é o teto — o enriquecimento por nicho vive no passo do funil do onboarding, onde o nicho existe. `on conflict do nothing` para nunca sobrescrever o que o dono editou.';

notify pgrst, 'reload schema';
