-- manifest: O card que ENTRA numa etapa passa a nascer no TOPO da coluna, e não no fim (issue #3461, item 1). `fn_mover_leads_em_lote` (o caminho do "mover para…" em lote, que é o do painel do Inbox) troca o piso `max(position_in_stage) + 1000 por card` por `min(position_in_stage) − 1000 por card`: o lote encosta ACIMA do primeiro card da etapa de destino e mantém entre si a ordem em que estava no quadro. Assinatura, colunas de retorno, atomicidade, os dois ramos do #2887 e a distinção de posições da 0209 continuam os mesmos. Etapa vazia segue nascendo em 1000, 2000, … `fn_nascer_lead_da_conversa` (o card que NASCE da primeira mensagem — a "conversa iniciada" da issue, e também quem `fn_nascer_lead_da_mensagem` chama) deixa de cair no DEFAULT 1000 da coluna e grava a mesma régua: `min(position_in_stage) − 1000` da etapa, `1000` na etapa vazia. Nenhuma coluna nova, nenhum backfill.
--
-- 9058 — issue #3461, item 1 (o defeito medido: conversa iniciada ou
-- transferida do Inbox para uma etapa aparecia no FIM da coluna).
--
-- ─── O que se mediu, e onde ────────────────────────────────────────────────
--
-- A ordem da coluna é `position_in_stage` CRESCENTE (menor primeiro), lida em
-- `app/api/v1/pipelines/[id]/board/route.ts` (`.order("position_in_stage")`).
-- Quatro escritores decidiam onde o recém-chegado entra, e nenhum gravava o
-- topo: a criação (`createLeadHandler`, `MAX + 1000`), o move sem posição
-- (`moveLeadHandler`, chamado pela MCP e pela automação — a rota
-- `POST /leads/[id]/move` exige `position_in_stage` no `moveLeadSchema` e não
-- passa por esse ramo), ESTA função, que é quem o
-- painel do Inbox dispara (`components/inbox/CRMSidePanel.tsx` → ação "move"
-- em `POST /api/v1/leads/bulk` → `fn_mover_leads_em_lote`), e o nascimento
-- pela conversa (`lib/leads/nascimento-do-lead.ts` → `fn_nascer_lead_da_conversa`,
-- direto ou por `fn_nascer_lead_da_mensagem`), cujo insert nem citava a coluna
-- e caía no DEFAULT 1000. Esse quarto é o que a issue nomeia primeiro ("quando
-- uma conversa é iniciada"); com só os três primeiros no topo, o card nascido
-- da conversa ficaria ABAIXO de todos os que entraram pelos outros caminhos.
-- Fora do banco, o mesmo PR leva ao topo os dois caminhos TypeScript que
-- ainda gravavam o fim: o encerramento (`lib/leads/encerramento.ts` — `/win`,
-- `/lose`, clone, retenção) e o "Mover para…"/seletor do dossiê do quadro.
--
-- Medido no Postgres local, numa coluna com três cards (1000, 2000, 3000),
-- antes desta migration: conversa iniciada caía em 4000 e transferida do Inbox
-- em 5000 — as duas no fim, que é exatamente o que a issue relata.
--
-- ─── O que muda ────────────────────────────────────────────────────────────
--
-- O piso passa a ser o TOPO: `min(position_in_stage) − 1000` por card, na
-- ordem do lote. É a mesma régua que a resposta rápida já usa desde a 0729
-- ("a resposta NOVA nasce no topo — um passo acima da primeira") e a mesma que
-- o TypeScript passou a aplicar em `lib/kanban/entrada-na-etapa.ts`. Só a
-- ponta muda: continua UM `return query execute`, as posições continuam
-- DISTINTAS entre os cards do lote (a razão de existir da 0209 — `midpoint`
-- empata em NaN quando dois vizinhos têm o mesmo número) e a contagem continua
-- atômica.
--
-- ⚠️ CONSEQUÊNCIA DECLARADA: mover em lote pelo quadro (barra de ações em
-- lote) também passa a empilhar no topo da etapa de destino. É o mesmo verbo —
-- "chegou nesta etapa" — e a alternativa (dois pisos, um para o Inbox e outro
-- para a barra do quadro) seria a mesma regra escrita duas vezes, que é como
-- as duas divergem na primeira mudança.
--
-- ⚠️ `%` no texto do `format` é marcador: o corpo abaixo não pode conter
-- nenhum além dos três `%s` (não contém). Quem for editar, confira.
--
-- Idempotente (`create or replace`, mesma assinatura da 0674 — sem `drop
-- function`, para não perder os grants no meio da cadeia), sem coluna nova e
-- sem dado tocado: os cards que já estão nas colunas não se movem.

create or replace function public.fn_mover_leads_em_lote(
  p_organization_id uuid,
  p_lead_ids uuid[],
  p_stage_id uuid,
  p_lost_reason text default null
) returns table (lead_id uuid, from_stage_id uuid, pipeline_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_min numeric;
  v_total int;
  -- Motivo em branco é ausência de motivo, nunca um motivo de uma letra.
  v_motivo text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_coluna_motivo text := '';
  v_filtro_novos text := '';
  v_filtro_preservados text := 'false';
begin
  -- Quantos cards o lote tem DE VERDADE. O predicado é o MESMO do `alvo` da
  -- escrita (organização + ids): contar por `array_length(p_lead_ids)` somaria
  -- id de outra organização — que o `alvo` descarta —, e a posição do primeiro
  -- card sairia de uma conta que inclui card que não vai ser movido.
  select count(*)
    into v_total
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.id = any(p_lead_ids);

  -- Onde o lote ENCOSTA: o primeiro card da etapa de destino, sem contar os que
  -- já estão no lote. `null` é a etapa vazia — e aí o lote ocupa o miolo de
  -- sempre (1000, 2000, …), pelo `coalesce` da escrita.
  select min(l.position_in_stage)
    into v_min
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.stage_id = p_stage_id
     and not (l.id = any(p_lead_ids));

  -- Só com motivo a gravar a coluna entra na escrita (0263; ver o cabeçalho) —
  -- e só quem NÃO estava perdido recebe a coluna (#2887). Sem motivo, o ramo dos
  -- novos leva o lote inteiro e o dos preservados não casa nenhuma linha.
  if v_motivo is not null then
    v_coluna_motivo := ', lost_reason = $4';
    v_filtro_novos := ' and l.status is distinct from ''lost''';
    v_filtro_preservados := 'l.status = ''lost''';
  end if;

  return query execute format($f$
  with alvo as (
    select l.id,
           l.stage_id    as from_stage_id,
           l.pipeline_id as pipeline_id,
           -- A ordem do lote no destino é a ordem em que ele estava no quadro:
           -- etapa, depois posição. `id` só desempata para o resultado ser
           -- determinístico (dois cards podem legitimamente empatar hoje —
           -- é justamente o estado que a migration 0209 deixa de produzir).
           row_number() over (order by l.stage_id, l.position_in_stage, l.id) as ordem
      from public.crm_leads l
     where l.organization_id = $1
       and l.id = any($2)
  ),
  novos as (
    update public.crm_leads l
       set stage_id          = $3,
           -- O TOPO da etapa (issue #3461): o lote inteiro encosta ACIMA do
           -- primeiro card e mantém entre si a ordem de origem. $5 é esse
           -- primeiro card; $6, o tamanho do lote. Etapa vazia ($5 nulo) cai
           -- no `coalesce` e ocupa 1000, 2000, … como um card criado à mão.
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1%s
    returning l.id, a.from_stage_id, a.pipeline_id
  ),
  preservados as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
           updated_at        = now()
      from alvo a
     where l.id = a.id
       and l.organization_id = $1
       and %s
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select n.id, n.from_stage_id, n.pipeline_id from novos n
  union all
  select p.id, p.from_stage_id, p.pipeline_id from preservados p
  $f$, v_coluna_motivo, v_filtro_novos, v_filtro_preservados)
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_min, v_total;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA no TOPO da coluna de destino (issue #3461): o lote encosta acima do primeiro card (`min - 1000` por card, na ordem em que estava no quadro) e não mais abaixo do último (`max + 1000`), que era o motivo de a conversa transferida do Inbox aparecer no fim. Etapa vazia continua nascendo em 1000, 2000, … Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. `p_lost_reason` (0263, issue #917) grava o motivo da perda na MESMA escrita quando a etapa de destino é de perda — sem ele a CHECK crm_leads_lost_reason_required recusava o lote inteiro com 23514; a coluna só entra na escrita quando há motivo, para não revalidar o valor que já estava na linha. #2887: a coluna só entra na escrita de quem NÃO estava perdido (`status is distinct from ''lost''`) — o negócio que já estava perdido é movido por um segundo ramo sem a coluna, e preserva o motivo dele. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

revoke all     on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from public;
revoke execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from anon;
grant  execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text)
  to authenticated, service_role;

-- ─── O quarto escritor: o card que nasce da conversa ───────────────────────
--
-- Cópia da ÚLTIMA definição (9045 — pessoa relacionada não abre outro negócio)
-- com UMA mudança: o insert passa a gravar `position_in_stage`, pela mesma
-- régua (`min − 1000` da etapa; `1000` na etapa vazia). A leitura do `min` fica
-- DENTRO do advisory lock por (organização, contato), depois da checagem de
-- "já existe": quem não vai inserir não lê. Dois contatos diferentes nascendo
-- juntos na mesma etapa podem empatar na posição; o quadro desempata por `id`
-- (`.order("id")` da leitura do board) e o arrasto seguinte ainda acha vizinho
-- distinto. Assinatura, `security invoker`, moeda e grants INALTERADOS.
create or replace function public.fn_nascer_lead_da_conversa(
  p_org uuid,
  p_contact uuid,
  p_pipeline uuid,
  p_stage uuid,
  p_title text,
  p_source text,
  p_source_metadata jsonb default '{}'::jsonb,
  p_tags text[] default '{}'::text[]
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Serializa por (organização, contato). Transaction-scoped: liberado no
  -- commit, sem risco de lock vazado.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_contact::text, 0));

  select id into v_id
    from public.crm_leads
   where organization_id = p_org
     and contact_id = p_contact
     and status = 'open'
   limit 1;

  -- 9045: o contato também pode ser uma PESSOA RELACIONADA de um negócio
  -- aberto (#3083) — o comprador, o gerente, o fixo da loja. Esse negócio já é
  -- a demanda dele; um card novo seria o "(2º número)" que a #3669 descreve.
  -- Segunda consulta, e não um OR na primeira: o caso comum (principal) segue
  -- no índice de sempre, e esta só roda para quem não tem negócio próprio.
  if v_id is null then
    select l.id into v_id
      from public.crm_lead_links k
      join public.crm_leads l on l.id = k.lead_id
     where k.organization_id = p_org
       and k.target_kind = 'contact'
       and k.link_kind = 'related'
       and k.target_id = p_contact
       and l.organization_id = p_org
       and l.status = 'open'
     limit 1;
  end if;

  -- NULL significa "já existe", e quem chama traduz isso para `ja_existe`. Não é
  -- erro: é o desfecho correto da segunda mensagem.
  if v_id is not null then
    return null;
  end if;

  -- A moeda é a da organização. Sem ela o negócio pegava o default da coluna
  -- ('BRL') em QUALQUER organização, e o valor que o assistente grava depois
  -- saía para a plataforma de anúncio como real: ₲125.000 viravam R$ 125.000.
  --
  -- 9058 (issue #3461): o card nasce no TOPO da etapa — um passo acima do
  -- primeiro, `1000` na etapa vazia —, a mesma régua da criação pela API e do
  -- move. Sem a coluna no insert ele caía no DEFAULT 1000 e ficava abaixo de
  -- todo card que tivesse entrado pelo topo.
  insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, contact_id, title, source, source_metadata, tags, currency, position_in_stage)
  values
    (p_org, p_pipeline, p_stage, p_contact, p_title, p_source, coalesce(p_source_metadata, '{}'::jsonb), coalesce(p_tags, '{}'::text[]),
     coalesce((select o.currency from public.organizations o where o.id = p_org), 'BRL'),
     coalesce((select min(l.position_in_stage) - 1000
                 from public.crm_leads l
                where l.organization_id = p_org
                  and l.stage_id = p_stage), 1000))
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) from public, anon;
grant  execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) to authenticated, service_role;
