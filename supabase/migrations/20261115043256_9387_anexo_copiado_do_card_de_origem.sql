-- manifest: **A cópia do anexo do card clonado sabe de qual anexo ela veio (#4544).** O card criado em outro funil leva os anexos da origem (#4569), mas a cópia não guardava o vínculo: repetir a cópia duplicava o anexo, e o ramo de `lead.won` em que a continuação JÁ existe respondia `ja_existia` sem tentar de novo — uma falha de Storage na primeira execução deixava o voucher fora do card de pós-venda para sempre. Coluna `clonado_do_attachment_id` (FK para a própria tabela, `on delete set null`: apagar a origem não apaga o voucher do card novo) e índice único parcial `crm_lead_attachments_clonado_unico` em `(lead_id, clonado_do_attachment_id)`, que é a idempotência no banco — a segunda execução (ou duas simultâneas) não duplica. A restrição do `storage_path` e o gatilho de imutabilidade NÃO foram afrouxados: a cópia continua sendo linha do próprio card, com objeto copiado pelo Storage. Gate: `tests/invariants/anexo-copiado-do-card-de-origem.test.ts`.
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
