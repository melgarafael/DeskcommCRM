-- manifest: **As cópias de playbook editadas antes do #1960 voltam a apontar o catálogo (issue #1974).** O fork-on-install (`installPlatformSkill`, `lib/ai/skills/install.ts`) gravou `forked_from_version_id` desde a 0068, mas o editor (`PUT /api/v1/ai/skills/[name]`, `app/api/v1/ai/skills/[name]/route.ts`), que entrou na main com o #1484 (merge `28e0baf41`, 2026-09-23T03:50:24Z), só passou a herdar o vínculo na versão nova com o #1960 (commit `24b0f3c35`, merge `cd31a305c`, 2026-09-30T00:04:41Z) — entre essas duas datas toda edição de cópia gravava a versão nova com o vínculo nulo, o ponteiro apontava para ela, `source` virava `manual` e `temVersaoNovaNoCatalogo` (`lib/ai/skills/versao-nova-catalogo.ts`) nunca disparava. O histórico de versões é imutável (regra dura 9), então a primeira versão da cópia ainda traz a origem: o backfill percorre as versões de cada `(organization_id, name)` em ordem de criação e carrega o último vínculo não nulo para as versões nulas da janela do defeito — cópia manual (que nunca passou pelo catálogo) não tem vínculo nenhum na linhagem e fica intocada. Janela declarada: `>= 2026-09-23T03:50:24Z` (o merge do #1484: antes dele o editor não existia, e o único caminho que gravava versão de organização com vínculo nulo era o import .zip = manual) e `< 2026-09-30T00:04:41Z` (o merge do #1960: depois disso o PUT herda sozinho, então nulo = importação .zip deliberada = manual). Número `0631`: a `0628` é a última da `main` e `0629`/`0630` estão tomadas por PRs abertos. Gate: `tests/unit/copias-antigas-de-skill-reconstruem-o-vinculo.test.ts` e o mesmo bloco no `supabase/baseline.sql`.
-- 0631: reconstrução do vínculo com o catálogo das cópias antigas de skill.
--
-- ─── O defeito, medido no código ─────────────────────────────────────────────────────────────
--
-- * A coluna `skill_versions.forked_from_version_id` nasceu na 0068 (2026-07-24,
--   commit `999b952a2`) JUNTO com o fork-on-install: `installPlatformSkill` gravou
--   `forkedFromVersionId: platform.id` desde o primeiro commit. Toda cópia
--   instalada do catálogo tem, portanto, a SUA PRIMEIRA versão com o vínculo.
-- * O `PUT /api/v1/ai/skills/[name]` (editor da tela) criava a versão nova SEM
--   passar o vínculo até o #1960 (commit `24b0f3c35`, merge `cd31a305c`,
--   2026-09-30T00:04:41Z, que acrescentou
--   `forkedFromVersionId: atual?.forked_from_version_id ?? null`). O próprio
--   editor entrou na main com o #1484 (o commit mais antigo que introduz
--   `ai.skill_saved` é `072ddd265`, mergeado em `28e0baf41` em
--   2026-09-23T03:50:24Z). Entre as duas datas, cada edição de cópia gravava
--   uma versão com o vínculo nulo e o ponteiro passava a apontar para ela.
-- * O efeito é o badge que nunca acende: o GET /api/v1/ai/skills deriva
--   `source` do vínculo da versão apontada e `versao_nova_catalogo` de
--   `temVersaoNovaNoCatalogo(forked, versaoAtualDaPlataforma)` — com o nulo,
--   `false` para sempre. E não havia backfill nenhum (medido: nenhuma migration
--   até aqui toca a coluna).
--
-- ─── Por que dá para reconstruir, e com que critério ─────────────────────────────────────────
--
-- O histórico de versões é append-only (gatilho `trg_skill_versions_immutable`),
-- então a linhagem de cada cópia preserva o fork original. A regra daqui é a
-- MESMA herança que o PUT faz desde o #1960, aplicada retroativamente:
--
--   para cada versão de ORG com `forked_from_version_id` nulo, na janela do
--   defeito, cuja mesma (org, name) tenha uma versão ANTERIOR com vínculo não
--   nulo apontando versão de PLATAFORMA: carrega o vínculo da anterior mais
--   recente.
--
-- As três guardas de confiança (a issue pedia critério para não ligar uma cópia
-- manual a uma versão do catálogo que ela nunca teve):
--
--   1. só nulos: vínculo já gravado jamais é reescrito;
--   2. só linhagem: quem nunca passou pelo catálogo não tem vínculo anterior em
--      nenhuma versão do (org, name) — cópia manual fica intocada por
--      construção;
--   3. só a janela: fora dela, um vínculo nulo significa importação .zip
--      deliberada (manual), não edição perdida. Antes do merge do #1484 o editor
--      não existia e o import .zip era o único caminho que gravava versão de
--      organização sem vínculo; depois do merge do #1960 o PUT herda sozinho.
--
-- Caso limite declarado: uma cópia que foi instalada do catálogo e teve um .zip
-- reimportado POR CIMA dentro da janela (sete dias) não é distinguido de uma
-- edição por este bloco, que só lê `skill_versions`, e herda
-- o vínculo da linhagem — escolha consciente no lado de avisar a equipe de uma
-- cópia com origem conhecida, nunca no lado de inventar origem. Instalação que
-- só atualizou MUITO depois do merge do #1960 e editou nesse intervalo não é
-- curada por esta janela (nulo pós-merge = manual, sem reprocesso possível) —
-- declarado, sem forçar reconstrução. Os dois casos poderiam ser separados pelo
-- `api_audit_log` (`ai.skill_imported` × `ai.skill_saved`, ambos com
-- `resource_id` = versão) num passo futuro, se valer.
--
-- O único obstáculo de escrita é a própria imutabilidade: UPDATE em
-- `skill_versions` é vetado por `trg_skill_versions_immutable`. O backfill
-- desliga e religa a trava no MESMO bloco `do` — um statement só, então ou a
-- religação acontece, ou a transação inteira (inclusive o desligamento) aborta.
-- `alter table` trava a tabela (ACCESS EXCLUSIVE) até o commit, então não existe
-- janela em que edição de conteúdo rode sem a trava. Conteúdo não muda: a
-- coluna é metadado de linhagem, e descrição/corpo/matcher/manifest seguem
-- intocados. Reaplicável: rodar de novo acha zero nulos na janela e não altera
-- nada (idempotente por construção — a própria condição de candidatura some).

do $$
declare
  v_alteradas integer;
begin
  execute 'alter table public.skill_versions disable trigger trg_skill_versions_immutable';

  with portadores as (
    select v.id,
           (select anterior.forked_from_version_id
              from public.skill_versions anterior
             where anterior.organization_id = v.organization_id
               and anterior.name = v.name
               and anterior.forked_from_version_id is not null
               and (anterior.created_at, anterior.id) < (v.created_at, v.id)
               and exists (
                 select 1
                   from public.skill_versions origem
                  where origem.id = anterior.forked_from_version_id
                    and origem.organization_id is null -- origem tem de ser versão de PLATAFORMA
               )
             order by anterior.created_at desc, anterior.id desc
             limit 1) as origem
      from public.skill_versions v
     where v.organization_id is not null      -- só cópia de organização; o catálogo nunca é cópia
       and v.forked_from_version_id is null   -- vínculo já gravado nunca é reescrito
       and v.created_at >= '2026-09-23T03:50:24Z'::timestamptz  -- #1484: o editor (PUT) que gravava o nulo nasce aqui; antes, nulo = import .zip
       and v.created_at <  '2026-09-30T00:04:41Z'::timestamptz  -- #1960: depois o PUT herda sozinho
  )
  update public.skill_versions v
     set forked_from_version_id = portadores.origem
    from portadores
   where v.id = portadores.id
     and portadores.origem is not null;

  get diagnostics v_alteradas = row_count;
  raise notice '0631: % versao(oes) de copia com o vinculo com o catalogo reconstruido', v_alteradas;

  execute 'alter table public.skill_versions enable trigger trg_skill_versions_immutable';
end $$;
