-- manifest: **A cópia do anexo do card clonado sabe de qual anexo ela veio (#4544).** O card criado em outro funil leva os anexos da origem (#4569), mas a cópia não guardava o vínculo: repetir a cópia duplicava o anexo, e o ramo de `lead.won` em que a continuação JÁ existe respondia `ja_existia` sem tentar de novo — uma falha de Storage na primeira execução deixava o voucher fora do card de pós-venda para sempre. Coluna `clonado_do_attachment_id` (FK para a própria tabela, `on delete set null`: apagar a origem não apaga o voucher do card novo) e índice único parcial `crm_lead_attachments_clonado_unico` em `(lead_id, clonado_do_attachment_id)`, que é a idempotência no banco — a segunda execução (ou duas simultâneas) não duplica. A restrição do `storage_path` e o gatilho de imutabilidade NÃO foram afrouxados: a cópia continua sendo linha do próprio card, com objeto copiado pelo Storage. As cópias já feitas na v1.111.0 (sem vínculo) são ligadas à origem por backfill idempotente: o card de origem que o destino declara em `source_metadata.clonado_de` + campo, nome, tamanho e tipo do arquivo, um para um. Gate: `tests/invariants/anexo-copiado-do-card-de-origem.test.ts`.
-- 9387 — A CÓPIA DO ANEXO SABE DE QUAL ANEXO ELA VEIO (#4544).
--
-- ═══ O que esta coluna fecha ═══
--
-- O card criado em outro funil leva os anexos do card de origem (#4569). A
-- cópia grava uma linha NOVA em `crm_lead_attachments`, com id e caminho novos —
-- o schema prende `storage_path` a `{org}/leads/{lead}/{campo}/{arquivo}` da
-- PRÓPRIA linha (`crm_lead_attachments_storage_path_check`) e o gatilho
-- `trg_crm_lead_attachments_caminho_imutavel` recusa qualquer `update` sobre
-- ele. Ou seja: duas linhas de cards diferentes não podem apontar para o mesmo
-- objeto, e a cópia duplica o objeto no bucket pelo Storage (`copy`).
--
-- Sem memória do que foi copiado, repetir a cópia DUPLICAVA o anexo — e o ramo
-- de "a continuação já existe" da automação não repetia nada, então uma falha
-- de Storage na primeira execução deixava o voucher fora do card de pós-venda
-- para sempre. Esta coluna é a chave que torna a cópia idempotente.
--
-- ═══ O que ela é ═══
--
--   1. VÍNCULO: qual linha do card de ORIGEM esta linha reproduz. A origem
--      continua com os seus — nada é movido nem apagado;
--   2. IDEMPOTÊNCIA: o índice único parcial abaixo garante, no BANCO, que um
--      par (card novo, anexo de origem) aparece uma vez só. Uma segunda
--      execução (ou duas simultâneas) não duplica linha;
--   3. RASTRO para a fatia do MCP (#4544, item 2): o anexo do card novo se
--      explica sozinho, sem depender de `source_metadata`.
--
-- `on delete set null` e NÃO `cascade`: apagar a linha de origem (ou o card de
-- origem, que leva as linhas por FK) não pode apagar o voucher do pós-venda —
-- ele é justamente o que precisa sobreviver. O ponteiro some; a linha e o
-- arquivo do card novo ficam.
alter table public.crm_lead_attachments
  add column if not exists clonado_do_attachment_id uuid
    references public.crm_lead_attachments(id) on delete set null;

comment on column public.crm_lead_attachments.clonado_do_attachment_id is
  'Anexo do card de ORIGEM que esta linha reproduz (#4544): preenchido só na cópia feita na clonagem para outro funil. Nulo em anexo que subiu direto no card.';

-- O mesmo anexo de origem pode estar em VÁRIOS cards (duas clonagens do mesmo
-- negócio), mas uma vez só em cada card. Parcial porque `null` é o estado
-- normal de todo anexo que subiu direto — e cada card tem quantos quiser.
create unique index if not exists crm_lead_attachments_clonado_unico
  on public.crm_lead_attachments(lead_id, clonado_do_attachment_id)
  where clonado_do_attachment_id is not null;

-- ═══ As cópias feitas ANTES desta coluna (v1.111.0, #4569) ═══
--
-- A cópia de anexos entrou na v1.111.0 sem o vínculo. Sem este passo, a
-- primeira vez que a automação repusesse anexos numa continuação criada
-- naquela versão, ela copiaria de novo cada arquivo — a duplicação que esta
-- migration existe para impedir. Aqui cada cópia antiga é pareada com o anexo
-- de origem pelo card de origem que o destino declara
-- (`source_metadata.clonado_de.lead_id`, gravado pelo clone) e pelo arquivo
-- (`field_key`, `file_name`, `file_size`, `mime_type`).
--
-- Um para um: cada cópia recebe no máximo uma origem, e cada origem no máximo
-- uma cópia por card (`rd`/`ro`), então o índice único acima não é violado.
-- ponytail: dois anexos IDÊNTICOS (mesmo campo, nome, tamanho e tipo) na mesma
-- origem: só o primeiro par é ligado, e o outro seria copiado uma vez mais na
-- reposição. Parear por conteúdo exigiria ler o Storage.
-- Idempotente: só toca linha com o vínculo nulo, e só liga par ainda livre.
with destino as materialized (
  select d.id, d.lead_id, d.organization_id, d.field_key, d.file_name, d.file_size,
         d.mime_type, d.created_at,
         (l.source_metadata -> 'clonado_de' ->> 'lead_id')::uuid as origem_lead_id
    from public.crm_lead_attachments d
    join public.crm_leads l on l.id = d.lead_id and l.organization_id = d.organization_id
   where d.clonado_do_attachment_id is null
     and (l.source_metadata -> 'clonado_de' ->> 'lead_id')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
par as (
  select d.id as destino_id, o.id as origem_id, d.lead_id,
         row_number() over (partition by d.id order by o.created_at, o.id) as rd,
         row_number() over (partition by d.lead_id, o.id order by d.created_at, d.id) as ro
    from destino d
    join public.crm_lead_attachments o
      on o.organization_id = d.organization_id
     and o.lead_id = d.origem_lead_id
     and o.field_key = d.field_key
     and o.file_name = d.file_name
     and o.file_size = d.file_size
     and o.mime_type = d.mime_type
)
update public.crm_lead_attachments a
   set clonado_do_attachment_id = p.origem_id
  from par p
 where a.id = p.destino_id
   and p.rd = 1
   and p.ro = 1
   and not exists (
     select 1 from public.crm_lead_attachments x
      where x.lead_id = p.lead_id and x.clonado_do_attachment_id = p.origem_id
   );
