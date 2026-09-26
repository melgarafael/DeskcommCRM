-- ============================================================================
-- 2026-09-26 — 0428: OS CANDIDATOS AO GOLDEN SET SAEM DO DISCO E VÃO PARA A
-- TABELA (issue #1695)
--
-- O matcher de skills (F3-09) e o classificador de etapa (F3-11) gravavam o
-- candidato de curadoria como JSON em `GOLDEN_CANDIDATES_DIR`. Medido na issue,
-- contra uma instálacao fresca: no desenvolvimento a pasta fica DENTRO do
-- repositório e o arquivo sai como `??` no `git status`; em produção o JSON vai
-- para o disco do contêiner — nenhuma tela o lê, ele se perde a cada atualização
-- de imagem e a cascata de anonimização da LGPD alcança o BANCO, não o disco.
--
-- O #1708 fechou as duas portas imediatas: o texto passou a sair pelo
-- `scrubMessage` antes de tocar o disco e os dois prefixos gerados em runtime
-- entraram no `.gitignore`. O que ficou em aberto — e é o que esta migration
-- faz — é o candidato sair do disco.
--
-- A FORMA é a do laço de retorno do Jev (0421), que é o padrão que a própria
-- issue aponta como correto: LINHA DE RÓTULO, sem texto de cliente. O que a
-- curadoria precisa ler — a conversa do lead — fica atrás do ponteiro `lead_id`,
-- lido por quem já tem acesso àquela organização; copiar o corpo da mensagem
-- para uma segunda cópia fora da cascata é exatamente o defeito que está saindo.
--
-- Idempotente: `create ... if not exists`, policy por `drop if exists` + `create`,
-- função `create or replace`, grants reemitidos. O retry do job re-grava o MESMO
-- candidato: os dois índices ÚNICOS parciais com o `on conflict do nothing` do
-- gravador mantêm "um registro por candidato" do tempo em disco — sem eles, um
-- job reprocessado duplicaria a curadoria.
--
-- RLS: leitura por membro da organização (é rótulo de MODEL, não dado de
-- pessoa), escrita só do servidor, que passa por cima. Retenção:
-- `fn_expurgar_candidatos_do_golden` — padrão 90 / piso 30 no CORPO, drenada em
-- lotes pelo cron `data-retention`, como as irmãs (0408, 0421).
-- ============================================================================

create table if not exists public.golden_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Ponteiro SEM FK, pela mesma razão da 0421: uma FK para leads/contacts ou
  -- travaria a anonimização ou apagaria o candidato junto do histórico, e a
  -- linha não guarda nada da pessoa para redigir.
  lead_id uuid,
  job_id uuid not null,
  -- Vocabulário ABERTO no CHECK de valor, FECHADO nas duas fontes que existem:
  -- é a coluna que diz quais rótulos a linha tem direito a trazer.
  fonte text not null
    constraint golden_candidates_fonte_check check (fonte in ('skill_match_miss', 'stage_classifier_divergence')),
  -- Rótulos do near-miss: qual skill devia ter disparado e por que o probe não
  -- virou hard-match.
  skill text,
  motivo text,
  -- Rótulos da divergência: o que o classificador auxiliar sugeriu e o que o
  -- modelo confirmou via update_lead_state.
  estagio_sugerido text,
  estagio_confirmado text,
  -- As DUAS fontes têm rótulos disjuntos: a checagem é o que impede uma linha da
  -- metade (skill-miss com estágio, divergência com skill) de nascer válida.
  constraint golden_candidates_rotulos_check check (
    (fonte = 'skill_match_miss'
      and skill is not null
      and motivo is not null
      and estagio_sugerido is null
      and estagio_confirmado is null)
    or (fonte = 'stage_classifier_divergence'
      and estagio_sugerido is not null
      and estagio_confirmado is not null
      and skill is null
      and motivo is null)
  ),
  created_at timestamptz not null default now()
);

comment on table public.golden_candidates is
  'Candidatos ao golden set (near-miss de skill e divergência classificador×modelo), em RÓTULO: sem texto de cliente, com ponteiro lead_id para quem quiser ler a conversa de verdade. Escrita só do servidor (lib/agent-engine/agent); leitura por membro da organização. Expurgada por fn_expurgar_candidatos_do_golden (cron data-retention).';

-- A poda: a ponta mais velha, de todas as organizações.
create index if not exists golden_candidates_criada_idx
  on public.golden_candidates (created_at);
-- A leitura por organização (a curadoria olha uma vez por casa).
create index if not exists golden_candidates_org_criada_idx
  on public.golden_candidates (organization_id, created_at desc);
-- Um candidato por (skill, job): o retry re-grava e não duplica — é o índice
-- que substitui o "um arquivo por candidato" do tempo em disco.
create unique index if not exists golden_candidates_uma_por_job_skill_idx
  on public.golden_candidates (organization_id, job_id, skill)
  where fonte = 'skill_match_miss';
create unique index if not exists golden_candidates_uma_por_job_divergencia_idx
  on public.golden_candidates (organization_id, job_id)
  where fonte = 'stage_classifier_divergence';

-- Leitura por qualquer membro da organização (rótulo de modelo, não dado de
-- pessoa); escrita só do servidor, que passa por cima da RLS. Sem policy ALL:
-- `authenticated` não tem por que escrever aqui.
alter table public.golden_candidates enable row level security;
drop policy if exists tenant_isolation_golden_candidates_select on public.golden_candidates;
create policy tenant_isolation_golden_candidates_select on public.golden_candidates
  for select using (organization_id in (select public.fn_user_org_ids()));

-- O ALTER DEFAULT PRIVILEGES do baseline dá GRANT ALL em TABLES a `anon`: toda
-- tabela nova nasce exposta e revoga por conta própria.
revoke all on public.golden_candidates from anon, authenticated;
grant select on public.golden_candidates to authenticated;
grant all on public.golden_candidates to service_role;

-- O prazo: padrão 90 dias (GOLDEN_CANDIDATES_RETENTION_DAYS), piso 30 — a
-- janela em que um near-miss ainda é curável. O piso mora NO CORPO, para valer
-- contra qualquer chamador, como as irmãs.
create or replace function public.fn_expurgar_candidatos_do_golden(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select g.id from public.golden_candidates g
     where g.created_at < now() - make_interval(days => v_dias)
     order by g.created_at
     limit v_limite
  )
  delete from public.golden_candidates g using vencidas v where g.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke all    on function public.fn_expurgar_candidatos_do_golden(int,int) from public;
revoke execute on function public.fn_expurgar_candidatos_do_golden(int,int) from anon;
revoke execute on function public.fn_expurgar_candidatos_do_golden(int,int) from authenticated;
grant  execute on function public.fn_expurgar_candidatos_do_golden(int,int) to service_role;
