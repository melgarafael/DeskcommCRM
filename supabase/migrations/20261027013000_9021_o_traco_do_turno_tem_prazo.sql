-- manifest: O traço do turno ganha poda por idade (#3201, entrega parcial da #2869). Função definer sem seletor de organização/linha, padrão 400 e piso 100 no corpo, lote com teto 10000, execute somente service_role. Reusa AI_TELEMETRY_RETENTION_DAYS, conforme decisão 218; índice de created_at e comentário guardado. Apêndice idempotente espelhado no baseline; a 0721 permanece intacta.
--
-- 9021 — adaptação da migration inédita 0778 de @webtecnica (#3516).
-- Número/carimbo reservados pelo mantenedor; fonte e autoria preservadas na história.
--
-- A retenção usa o knob existente da telemetria da IA: padrão 400, piso 100.
-- A API é uma entrega parcial; a tela continua na issue #3201. O leitor corta
-- a janela no instante agora - retenção e entrega recibos técnicos projetados.
-- As linhas legadas podem conter texto livre de erro: esta poda NÃO é uma
-- higienização de conteúdo nem substitui a projeção segura do leitor.
--
-- Função irmã da 0587, sem editar sua definição aplicada. Reaplicar não muda
-- o piso, não seleciona organização/id e não produz auditoria quando não apagou.

-- Índice de poda: o DELETE por idade é diário e cresceria com a tabela. O
-- índice que já existe começa por `organization_id` (0721), e esta poda não tem
-- seletor de organização — sem este, cada rodada varre a tabela inteira.
create index if not exists idx_agent_turn_traces_expurgo_created_at
  on public.agent_turn_traces (created_at);

-- O expurgo do traço do turno vencido. Mesma forma da família da 0587:
-- `security definer` SEM seletor de linha (nenhum parâmetro de organização,
-- contato, conversa ou id — o único predicado vindo de fora é a idade), piso
-- dentro do CORPO (vale para qualquer chamador, inclusive um `psql` na mão),
-- lote com teto de 10000 e revogação de `public`/`anon`/`authenticated`.
create or replace function public.fn_expurgar_traco_do_turno_vencido(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 400 = o mesmo padrão de `AI_TELEMETRY_RETENTION_DAYS` (RETENCAO_TELEMETRIA_
  -- DE_IA_DIAS_PADRAO) e 100 = o mesmo piso (RETENCAO_TELEMETRIA_DE_IA_DIAS_
  -- PISO). Os números são repetidos aqui de propósito, como nas irmãs da 0587:
  -- a função vale para chamador que não passou pelo TypeScript (o `psql` da
  -- madrugada). O par SQL × TypeScript é medido em
  -- `tests/unit/retencao-do-traco-do-turno.test.ts`.
  v_dias int := greatest(coalesce(p_retencao_dias, 400), 100);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_corte timestamptz := now() - make_interval(days => v_dias);
  v_apagadas int;
begin
  -- O corte fica no `where` ANTES do `limit` (a lição da 0167): filtrar depois
  -- faria um lote inteiro de linhas ainda válidas devolver 0 e o cron parar com
  -- backlog atrás.
  with vencidas as (
    select t.id from public.agent_turn_traces t
     where t.created_at < v_corte
     order by t.created_at limit v_limite
  )
  delete from public.agent_turn_traces t using vencidas v where t.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_expurgar_traco_do_turno_vencido(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_traco_do_turno_vencido(int,int) to service_role;

-- O relógio da poda é `created_at`, e quem lê o traço pergunta por ele. Dizer
-- isso na coluna é o que impede a próxima pessoa de indexar/filtrar por
-- `updated_at` (que muda no upsert de um turno repetido) achando que é o mesmo
-- eixo. Dentro da guarda: num clone sem a tabela da 0721 o comentário não pode
-- derrubar a atualização.
do $$
begin
  if to_regclass('public.agent_turn_traces') is not null then
    comment on column public.agent_turn_traces.created_at is
      'Quando o turno gravou o traço. É o relógio de fn_expurgar_traco_do_turno_vencido (9021) e o eixo do leitor /api/v1/ai/turn-traces — NÃO confundir com updated_at, que o upsert reescreve quando o mesmo job regrava.';
  end if;
end
$$;

notify pgrst, 'reload schema';
