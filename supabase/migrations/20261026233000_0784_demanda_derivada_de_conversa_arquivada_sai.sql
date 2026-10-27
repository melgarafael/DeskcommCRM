-- manifest: Limpa a demanda 'derivada' que o backfill R2 criou de conversa ARQUIVADA antes do #2825 — só a que está aberta, intocada (sem caso, negócio, dono humano ou próximo passo), com TODAS as conversas vinculadas arquivadas, carregando a assinatura do R2 e sem ninguém apontando para ela; relatório por organização em tabela temporária + raise notice; idempotente por estado.

-- ============================================================================
-- 0784 — O RESÍDUO DA DERIVAÇÃO ANTIGA SAI (#2992)
--
-- O R2 do apêndice "Índice de Atrito + DEMANDAS" do `baseline.sql` deriva uma
-- demanda de toda conversa que nunca escalou. Ele só conhecia `resolved` e
-- `closed` como terminais, então conversa `archived` caía no `else 'aberta'` e
-- ficava pendente para sempre. O PR #2825 consertou a ORIGEM (`where cv.status
-- <> 'archived'`) — e isso vale de agora em diante.
--
-- O que ficou: quem já aplicou o backfill antes do conserto (pela migration
-- 0136 ou por um `update.sh` anterior) tem demandas ABERTAS, sem desfecho,
-- derivadas de conversa arquivada. Elas reaparecem na consulta de pendências a
-- cada rodada; o #2825 não as remove porque ele não apaga nada, só deixa de
-- criar.
--
-- ─── O CRITÉRIO (curto de propósito: é a única limpeza que apaga demanda) ───
--
-- Uma demanda só sai quando TODAS valem:
--
--   * `origem = 'derivada'` — é a que o R2 criou. `inbound` (trigger da 0138),
--     `handoff`, `followup` e `manual` não são tocadas em nenhum caso;
--   * ABERTA: `fechada_em is null` (e `desfecho is null`, por coerência);
--   * INTOCADA: sem `agent_case_id`, sem `lead_id`, sem `dono_user_id` e sem
--     `proximo_passo`. Alguém assumiu, ligou a um negócio ou escreveu o próximo
--     passo ⇒ a demanda é decisão de gente, não resíduo de backfill;
--   * tem vínculo em `demanda_conversas` e TODAS as conversas vinculadas estão
--     `archived`. A demanda que atravessou para um canal vivo FICA: ela ainda é
--     o que precisa acabar (é o caso "compartilhada entre canais" da #2822);
--   * carrega a assinatura do R2 — `aberta_em = conversations.created_at`, que
--     é como o backfill derivou e como o vínculo N:N foi montado;
--   * NINGUÉM aponta para ela: `conversations.current_demanda_id`,
--     `messages.demanda_id`, `lead_checkpoints.demanda_id` e
--     `crm_tasks.demanda_id` são `on delete set null` — apagar zeraria o
--     vínculo de quem está usando a demanda.
--
-- ─── O QUE NÃO SE FAZ ───────────────────────────────────────────────────────
--
-- Encerrar com desfecho. `resolvida` e `nao_procede` afirmariam um desfecho que
-- não houve, e `demandas_desfecho_coerente` exige desfecho junto de
-- `fechada_em` — inventar um dos dois é escrever história falsa no banco. O
-- registro sai inteiro; nada é inventado no lugar dele.
--
-- ─── RELATÓRIO ──────────────────────────────────────────────────────────────
--
-- As linhas apagadas passam por `_limpeza_2992` (temporária, `on commit drop`),
-- contadas POR ORGANIZAÇÃO, e o bloco fecha com `raise notice` do total. Quem
-- roda `supabase db push` ou `update.sh` vê o que saiu; uma rodada sem nada a
-- limpar diz isso, em vez de ficar em silêncio.
--
-- ─── IDEMPOTÊNCIA ───────────────────────────────────────────────────────────
--
-- Por ESTADO, não por marca: o casamento é o próprio banco, então a segunda
-- passada não encontra nenhuma linha que case e apaga 0 (o relatório dela fica
-- vazio). O `update.sh` re-aplica o baseline a cada atualização, e é por isso
-- que a marca não serviria.
--
-- ─── POR QUE `do` + `execute` ───────────────────────────────────────────────
--
-- As colunas de referência nascem em blocos MAIS ABAIXO do ponto do baseline
-- onde este bloco vive (0222 e #2818): num `install` elas ainda não existem — e
-- ali não há demanda nenhuma para limpar. Sem a coluna não existe referência a
-- poupar, então a guarda correspondente simplesmente não entra no `where`.
-- Escrever as quatro incondicionalmente obrigaria `execute` de qualquer forma;
-- assim a única coisa montada dinamicamente são as guardas, e o corpo do
-- `delete` fica legível.
--
-- O apêndice do `baseline.sql` carrega o MESMO bloco, byte a byte.
-- ============================================================================

do $$
declare
  v_rodada  int;
  v_filtros text := '';
  v_total   bigint := 0;
  v_org     record;
begin
  if to_regclass('public.demandas') is null
     or to_regclass('public.demanda_conversas') is null
     or to_regclass('public.conversations') is null then
    raise notice '#2992: tabelas de demandas ausentes nesta instalação — nada a limpar';
    return;
  end if;

  create temp table if not exists _limpeza_2992 (
    rodada          int         not null,
    organization_id uuid,
    apagadas        bigint      not null,
    em              timestamptz not null default clock_timestamp()
  ) on commit drop;

  select coalesce(max(rodada), 0) + 1 into v_rodada from _limpeza_2992;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'conversations'
                and column_name = 'current_demanda_id') then
    v_filtros := v_filtros
      || ' and not exists (select 1 from public.conversations r where r.current_demanda_id = d.id)';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'messages'
                and column_name = 'demanda_id') then
    v_filtros := v_filtros
      || ' and not exists (select 1 from public.messages r where r.demanda_id = d.id)';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'lead_checkpoints'
                and column_name = 'demanda_id') then
    v_filtros := v_filtros
      || ' and not exists (select 1 from public.lead_checkpoints r where r.demanda_id = d.id)';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'crm_tasks'
                and column_name = 'demanda_id') then
    v_filtros := v_filtros
      || ' and not exists (select 1 from public.crm_tasks r where r.demanda_id = d.id)';
  end if;

  execute format($limpeza$
    with apagadas as (
      delete from public.demandas d
       where d.origem = 'derivada'
         and d.fechada_em is null
         and d.desfecho is null
         and d.agent_case_id is null
         and d.lead_id is null
         and d.dono_user_id is null
         and d.proximo_passo is null
         -- tem vínculo de conversa (senão não é este o defeito)
         and exists (
           select 1
             from public.demanda_conversas v
            where v.demanda_id = d.id
         )
         -- e nenhuma conversa VIVA: todas as vinculadas estão arquivadas
         and not exists (
           select 1
             from public.demanda_conversas v
             join public.conversations cv on cv.id = v.conversation_id
            where v.demanda_id = d.id
              and cv.status <> 'archived'
         )
         -- e ao menos uma delas carrega a assinatura do backfill R2
         and exists (
           select 1
             from public.demanda_conversas v
             join public.conversations cv on cv.id = v.conversation_id
            where v.demanda_id = d.id
              and cv.status = 'archived'
              and cv.created_at = d.aberta_em
         )
         %s
       returning d.organization_id
    )
    insert into _limpeza_2992 (rodada, organization_id, apagadas)
    select %s, organization_id, count(*)
      from apagadas
     group by organization_id
  $limpeza$, v_filtros, v_rodada);

  select coalesce(sum(apagadas), 0) into v_total
    from _limpeza_2992 where rodada = v_rodada;

  for v_org in select organization_id, apagadas
                 from _limpeza_2992
                where rodada = v_rodada
                order by apagadas desc loop
    raise notice '#2992 rodada % — organização %: % demanda(s) derivada(s) de conversa arquivada apagada(s)',
      v_rodada, v_org.organization_id, v_org.apagadas;
  end loop;

  raise notice '#2992 rodada % — % demanda(s) apagada(s) no total', v_rodada, v_total;
end $$;
