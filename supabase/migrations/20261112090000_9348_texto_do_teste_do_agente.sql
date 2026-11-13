-- manifest: O TESTE do agente guarda a pergunta e a resposta, e a aba "Execuções" as mostra (#4426). Duas colunas de texto em `ai_agent_runs` (`input_text`, `output_text`), escritas pelo ÚNICO escritor vivo da tabela — a prévia `POST /api/v1/ai/agents/:id/versions/:vid/test` —, e `llm_calls.preview_run_id`, o elo que leva da linha de execução (a aba lê `llm_calls`, o motor que responde de verdade) ao run de prévia que guarda o texto. Sem ele, ligar as duas pontas seria adivinhar por horário, e dois testes simultâneos do mesmo agente trocariam de texto entre si. O expurgo da telemetria de IA (0587, 400/100) passa a ANULAR os dois textos vencidos, em vez de esperar que a linha suma: o custo da execução continua auditável sem o conteúdo. Idempotente, sem policy, sem grant novo.
--
-- ─── Por que o texto não vai para `llm_calls` ──────────────────────────────
--
-- `llm_calls` é por CHAMADA de modelo: um turno de prévia com ferramentas grava
-- várias linhas (o turno e a correção), e a mesma pergunta iria repetida em
-- todas — além de encher a tabela mais quente da instalação com conteúdo de
-- texto. O run de prévia é UM por execução de teste; o texto pertence a ele.
--
-- ─── Por que a coluna-ponte é `uuid` e não tem FK ──────────────────────────
--
-- `ai_agent_runs.id` é uuid. FK aqui seria uma checagem a mais em TODO INSERT de
-- `llm_calls` (a tabela mais escrita do produto) para proteger um ponteiro de
-- LEITURA: se o run de prévia sumir, o pior caso é a linha da aba abrir sem
-- texto — que é exatamente o estado de hoje. A coluna é nula em toda execução
-- real, e o índice é parcial por isso.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- `llm_calls` continua sendo a fonte da aba (tokens, custo, latência, status) e
-- o `purpose='agent_preview'` com `contact_id` nulo continua sendo o que marca
-- a linha como teste. Nenhuma linha existente muda de valor.

alter table public.ai_agent_runs
  add column if not exists input_text text,
  add column if not exists output_text text;

comment on column public.ai_agent_runs.input_text is
  'A mensagem que a pessoa digitou no painel de teste (#4426). Nula em toda execução real. Limitada a 4000 caracteres pela rota (o mesmo teto do schema do POST).';
comment on column public.ai_agent_runs.output_text is
  'A resposta final que a IA deu no teste (#4426) — o MESMO texto que o painel mostrou. Nula em toda execução real. Limitada a 8000 caracteres pela rota.';

alter table public.llm_calls
  add column if not exists preview_run_id uuid;

comment on column public.llm_calls.preview_run_id is
  'O run de prévia (`ai_agent_runs.id`) que causou esta chamada (#4426). Nulo em toda execução real; é o elo que a aba "Execuções" usa para buscar a pergunta e a resposta gravadas no run.';

create index if not exists idx_llm_calls_preview_run
  on public.llm_calls (preview_run_id)
  where preview_run_id is not null;

-- ─── O texto tem prazo: o expurgo da telemetria o anula ────────────────────
--
-- O expurgo da 0587 apaga `llm_calls`, `metrics`, `skill_activations` e
-- `ai_router_decisions` vencidos (400 dias, piso 100). `ai_agent_runs` ficava
-- fora — e o texto digitado por uma pessoa pode conter dado de cliente colado.
-- Apagar a LINHA do run levaria junto o custo e a latência que a aba mostra;
-- anular o TEXTO é o que o prazo pede: o conteúdo sai, a execução continua
-- auditável. Conta no retorno da função, que o cron grava em
-- `retention.sweep_run`.
create or replace function public.fn_expurgar_telemetria_de_ia_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 400), 100);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_corte timestamptz := now() - make_interval(days => v_dias);
  v_n int;
  v_total int := 0;
begin
  with vencidas as (
    select c.id from public.llm_calls c
     where c.created_at < v_corte and c.legacy_invocation_id is null
     order by c.created_at limit v_limite
  )
  delete from public.llm_calls c using vencidas v where c.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select m.id from public.metrics m
     where m.created_at < v_corte
     order by m.created_at limit v_limite
  )
  delete from public.metrics m using vencidas v where m.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select s.id from public.skill_activations s
     where s.created_at < v_corte
     order by s.created_at limit v_limite
  )
  delete from public.skill_activations s using vencidas v where s.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select r.id from public.ai_router_decisions r
     where r.created_at < v_corte
     order by r.created_at limit v_limite
  )
  delete from public.ai_router_decisions r using vencidas v where r.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- #4426: o TEXTO do teste vence junto com a telemetria, e a linha FICA. O
  -- `input_text is not null or output_text is not null` é o que impede a
  -- varredura de reescrever (e contar) em toda rodada as linhas já anuladas.
  with vencidas as (
    select a.id from public.ai_agent_runs a
     where a.created_at < v_corte
       and (a.input_text is not null or a.output_text is not null)
     order by a.created_at limit v_limite
  )
  update public.ai_agent_runs a
     set input_text = null, output_text = null
    from vencidas v
   where a.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;
revoke execute on function public.fn_expurgar_telemetria_de_ia_vencida(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_telemetria_de_ia_vencida(int,int) to service_role;
