-- manifest: **A reconstrução do vínculo com o catálogo passa a ser ancorada na trilha de auditoria, e o vínculo inventado pela 0644 é solto (issue #1976).** A 0644 curou a janela `[#1484, #1960)` pela ORDEM das versões: toda versão de organização com `forked_from_version_id` nulo naquela semana cuja linhagem tivesse uma versão anterior apontando plataforma herdava o vínculo. Medido num Postgres com o baseline completo (42 cópias sintéticas, 6 por classe, criadas pelo DAO real `insertSkillVersion` e pelo `installPlatformSkill` real — `tests/invariants/reconstrucao-do-vinculo-ancorada-na-auditoria.test.ts`): a 0644 cura a edição simples do editor (6/6), mas **inventa origem** em 12 cópias que eram manuais de fato — as que receberam um `.zip` por cima de uma cópia do catálogo, dentro da janela (6/6) e antes dela (6/6) —, e **não alcança** 6 cópias editadas na janela e editadas OUTRA vez depois do #1960, porque a segunda edição herdou o nulo e caiu fora da janela. O discriminador que faltava está em `api_audit_log`: cada gravador de versão deixa uma linha com `resource_type = 'skill_versions'` e `resource_id` = id da versão, então `ai.skill_installed` (fork-on-install), `ai.skill_imported` (o `.zip`) e `ai.skill_saved` (o editor) dizem QUEM criou cada versão. Duas passadas: (1) **solta** o vínculo de toda versão cujo evento de origem mais recente na linhagem é um import `.zip` — esse caminho nunca grava vínculo, então vínculo ali só pode ter vindo do backfill da 0644 (é o caso em que adotar a versão nova sobrescreveria o conteúdo que o operador importou: vínculo inventado é pior que vínculo ausente, porque o ausente cala e o inventado age); (2) **cura** toda versão nula criada pelo editor cuja âncora mais recente aponte plataforma, exigindo `ai.skill_saved` em TODA versão entre a âncora e ela — um `.zip` no meio da cadeia torna a cópia manual e a cura não acontece. Versão sem linha de auditoria fica como está e é contada no `raise notice`: ausência de prova nunca vira vínculo. As duas passadas erram para o lado do nulo (manual, sem aviso), nunca para o lado do aviso que não existe. Idempotente, desliga/religa `trg_skill_versions_immutable` no mesmo bloco e não toca conteúdo. Apêndice idêntico no `supabase/baseline.sql`, logo depois do bloco da 0644 e antes da VARREDURA anon.
-- 0808: vínculo com o catálogo por evidência de auditoria, e soltura do vínculo inventado.
--
-- ─── Por que a 0644 não bastava, medido ──────────────────────────────────────────────────────
--
-- A 0644 declara as próprias limitações: "uma cópia que foi instalada do catálogo
-- e teve um .zip reimportado POR CIMA dentro da janela … herda o vínculo da
-- linhagem" e "instalação que só atualizou MUITO depois do merge do #1960 e
-- editou nesse intervalo não é curada por esta janela". As duas pontas
-- apareceram na medição, no harness do `pnpm test:db` (Postgres com o baseline
-- aplicado em install e update; cópias criadas pelo DAO e pelo
-- `installPlatformSkill` de verdade, com a trilha que o `audit()` grava):
--
--   classe                                   antes   depois da 0644   veredito
--   instalada + editada na janela              0/6       6/6   curada
--   instalada + editada na janela + editada    0/6       0/6   NÃO alcançada
--     de novo depois do #1960 (herda o nulo)
--   instalada + editada só depois do #1960     6/6       6/6   controle
--   .zip na janela (manual puro)               0/6       0/6   controle
--   instalada + .zip por cima na janela        0/6       6/6   origem INVENTADA
--   instalada + .zip antes + editada depois    0/6       6/6   origem INVENTADA
--   instalada e nunca editada                  6/6       6/6   controle
--
-- ("6/6" = cópias com `forked_from_version_id` na versão que o ponteiro aponta —
-- é o que o GET `/api/v1/ai/skills` lê para derivar `source` e
-- `versao_nova_catalogo`; "antes" = sem backfill nenhum.)
--
-- ─── O discriminador: quem criou a versão ───────────────────────────────────────────────────
--
-- `api_audit_log` grava, para cada versão criada, uma linha com
-- `resource_type = 'skill_versions'` e `resource_id` = id da versão:
--
--   ai.skill_installed  fork-on-install do catálogo  → grava o vínculo
--   ai.skill_imported   o .zip da organização        → NUNCA grava o vínculo
--   ai.skill_saved      o editor (PUT)               → não gravou o vínculo até o #1960
--
-- Como a criação da versão é um INSERT só (append-only pela regra dura 9),
-- essas linhas são a evidência de autoria que separa "nulo por ser manual" de
-- "nulo por defeito".
--
-- ─── Passada 1: solta o vínculo que o import não gravou ─────────────────────────────────────
--
-- Para cada versão de org COM vínculo, procura na própria linhagem (mesma org e
-- name, até ela inclusive) o evento de origem mais recente entre install e
-- import. Se for `ai.skill_imported`, a cópia era manual naquele ponto e todo
-- vínculo dali para a frente foi posto pelo backfill da 0644 — sai. Cobre as
-- duas formas medidas: a própria versão do import e as edições posteriores que
-- herdaram o vínculo inventado.
--
-- ─── Passada 2: cura a herança do #1960 com prova em cada elo ────────────────────────────────
--
-- Para cada versão de org com vínculo nulo:
--
--   a) achar a ÂNCORA: a versão anterior MAIS RECENTE da mesma (org, name) com
--      vínculo não nulo que aponte versão de plataforma (existe hoje, como na
--      0644);
--   b) a versão tem de ter `ai.skill_saved` — foi o editor que a criou, não um
--      .zip;
--   c) TODA versão entre a âncora e ela — nula ou não, porque a 0644 pode ter
--      curado uma versão de import no meio — tem de ter `ai.skill_saved`. Um
--      `.zip` na cadeia teria tornado a cópia manual, e aí o nulo de hoje é
--      verdade e não defeito.
--
-- O que fica de fora, de propósito: versão sem linha de auditoria (o `audit()` é
-- fire-and-forget e pode ter falhado), versão cujo criador não é nenhum dos três
-- caminhos conhecidos, e qualquer cópia cuja cadeia tenha um elo sem prova.
-- Todas continuam exatamente como estão — nulas, aparecendo como manual, sem
-- aviso — e são contadas no `raise notice`. A issue é explícita: ambíguo fica
-- nulo e é reportado; inventar vínculo não é cura.
--
-- ─── Mecânica ───────────────────────────────────────────────────────────────────────────────
--
-- O UPDATE em `skill_versions` é vetado por `trg_skill_versions_immutable`, e a
-- trava é desligada/religada no MESMO bloco `do` (um statement só: ou a
-- religação acontece, ou a transação inteira aborta). `alter table` trava a
-- tabela até o commit, então não existe janela sem a trava. Conteúdo não muda:
-- a coluna é metadado de linhagem. Reaplicável: a passada 1 não acha mais
-- versão de import com vínculo, e a passada 2 não acha mais candidata nula com
-- cadeia provada.

do $$
declare
  v_soltas integer;
  v_curadas integer;
  v_pendentes integer;
begin
  execute 'alter table public.skill_versions disable trigger trg_skill_versions_immutable';

  -- ─── Passada 1: o vínculo de quem foi .zip por cima do catálogo ─────────────
  update public.skill_versions v
     set forked_from_version_id = null
    from (
      select copia.id
        from public.skill_versions copia
       where copia.organization_id is not null
         and copia.forked_from_version_id is not null
         and 'ai.skill_imported' = (
               select evento.action
                 from public.skill_versions elo
                 join public.api_audit_log evento on evento.resource_id = elo.id
                where elo.organization_id = copia.organization_id
                  and elo.name = copia.name
                  and (elo.created_at, elo.id) <= (copia.created_at, copia.id)
                  and evento.resource_type = 'skill_versions'
                  and evento.action in ('ai.skill_installed', 'ai.skill_imported')
                order by elo.created_at desc, elo.id desc
                limit 1)
    ) manuais
   where v.id = manuais.id;

  get diagnostics v_soltas = row_count;

  -- ─── Passada 2: cura onde a cadeia inteira é do editor ──────────────────────
  with candidatas as (
    select v.id,
           v.organization_id,
           v.name,
           v.created_at,
           ancora.created_at as ancora_em,
           ancora.id as ancora_id,
           ancora.forked_from_version_id as origem
      from public.skill_versions v
      join lateral (
        select a.id, a.created_at, a.forked_from_version_id
          from public.skill_versions a
         where a.organization_id = v.organization_id
           and a.name = v.name
           and a.forked_from_version_id is not null
           and (a.created_at, a.id) < (v.created_at, v.id)
           and exists (
             select 1
               from public.skill_versions origem_plataforma
              where origem_plataforma.id = a.forked_from_version_id
                and origem_plataforma.organization_id is null -- a origem tem de ser versão de PLATAFORMA
           )
         order by a.created_at desc, a.id desc
         limit 1
      ) ancora on true
     where v.organization_id is not null
       and v.forked_from_version_id is null
  ),
  provadas as (
    select c.id, c.origem
      from candidatas c
     where exists (
             select 1
               from public.api_audit_log salva
              where salva.resource_type = 'skill_versions'
                and salva.resource_id = c.id
                and salva.action = 'ai.skill_saved'   -- o editor criou ESTA versão
           )
       and not exists (
             select 1
               from public.skill_versions elo
              where elo.organization_id = c.organization_id
                and elo.name = c.name
                and (elo.created_at, elo.id) > (c.ancora_em, c.ancora_id)
                and (elo.created_at, elo.id) < (c.created_at, c.id)
                and not exists (
                      select 1
                        from public.api_audit_log salva_elo
                       where salva_elo.resource_type = 'skill_versions'
                         and salva_elo.resource_id = elo.id
                         and salva_elo.action = 'ai.skill_saved' -- elo sem prova bloqueia a cura
                    )
           )
  )
  update public.skill_versions v
     set forked_from_version_id = provadas.origem
    from provadas
   where v.id = provadas.id;

  get diagnostics v_curadas = row_count;

  select count(*) into v_pendentes
    from public.skill_versions v
   where v.organization_id is not null
     and v.forked_from_version_id is null;

  raise notice '0808: % vinculo(s) inventado(s) solto(s), % versao(oes) curada(s) por evidencia, % versao(oes) de org seguem sem vinculo',
    v_soltas, v_curadas, v_pendentes;

  execute 'alter table public.skill_versions enable trigger trg_skill_versions_immutable';
end $$;
