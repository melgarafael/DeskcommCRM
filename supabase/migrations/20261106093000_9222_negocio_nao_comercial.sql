-- 9222 · NEGÓCIO NÃO COMERCIAL (issue #4191)
--
-- Um contato identificado pela equipe como golpe recebeu etiqueta e a conversa
-- foi encerrada, mas o negócio continuou aberto no Radar. Marcar como perdido
-- afirmaria uma perda comercial que não existiu; excluir o card descartaria
-- contato, conversa e atividades. Esta migration dá ao negócio o TERCEIRO
-- estado que faltava: fora do comercial, sem desfecho.
--
-- Três colunas, todas NULLABLE e SEM DEFAULT, porque a coluna nula é o estado
-- de hoje (todo negócio é comercial) e um DEFAULT forçaria backfill de toda a
-- base no upgrade:
--
--   nao_comercial_em     · quando a equipe classificou (a coluna que DECIDE —
--                          é por ela que Radar e métricas filtram);
--   nao_comercial_motivo · por quê, texto declarado pela equipe. Sem CHECK de
--                          vocabulário: a issue pede o motivo e deixa a lista
--                          "a discutir"; fechar a lista aqui seria inventar a
--                          regra e travar a correção de um caso novo;
--   nao_comercial_por    · quem decidiu (uuid de auth.users, sem FK — o mesmo
--                          desenho de crm_leads.created_by_user_id, que também
--                          não tem FK: apagar a pessoa não pode apagar a
--                          decisão).
--
-- A classificação NÃO mexe em `status`, `lost_reason`, `closed_at`, etapa nem
-- nos vínculos: contato, conversa, mensagens, anexos e atividades ficam
-- exatamente onde estão. Reverter é apagar as três colunas — a reversão fica
-- na timeline (`demand_classified`) e no audit, não numa quarta coluna.
--
-- Idempotente (`add column if not exists`, índice `if not exists`): o
-- `update.sh` do clone re-executa o apêndice inteiro do `baseline.sql` a cada
-- atualização. Sem backfill: linha existente continua comercial.
alter table public.crm_leads
  add column if not exists nao_comercial_em timestamptz,
  add column if not exists nao_comercial_motivo text,
  add column if not exists nao_comercial_por uuid;

-- O par (quando, motivo) é uma coisa só: classificou, tem motivo. A recusa é no
-- banco porque a operação é humana e duas abas abertas não podem gravar uma
-- classificação sem porquê. Nomeada e reaplicável (drop before add): o
-- `baseline.sql` roda o mesmo texto a cada atualização.
alter table public.crm_leads
  drop constraint if exists crm_leads_nao_comercial_coerente;
alter table public.crm_leads
  add constraint crm_leads_nao_comercial_coerente check (
    nao_comercial_em is null
    or (nao_comercial_motivo is not null and length(btrim(nao_comercial_motivo)) > 0)
  );

comment on column public.crm_leads.nao_comercial_em is
  'Quando a equipe classificou o negócio como NÃO comercial (issue #4191, migration 9222). null = comercial, o estado de sempre. É a coluna que DECIDE: Radar e métricas de funil filtram por ela. Não é desfecho — status, etapa e closed_at não mudam.';
comment on column public.crm_leads.nao_comercial_motivo is
  'Por que o negócio foi classificado como não comercial (issue #4191). Texto declarado pela equipe (golpe, spam, contato sem finalidade comercial…), sem vocabulário fechado no banco: a lista está em discussão na issue e um CHECK travaria a correção de um caso novo.';
comment on column public.crm_leads.nao_comercial_por is
  'Quem classificou o negócio como não comercial (issue #4191). Sem FK, como created_by_user_id: apagar a pessoa não pode apagar a decisão.';

-- Encontrar os classificados é requisito de aceite ("consulta/filtro para
-- encontrar os classificados e restaurar"). Índice PARCIAL porque o caso comum
-- é a coluna nula: o índice só cresce com o que foi classificado.
create index if not exists crm_leads_nao_comerciais_idx
  on public.crm_leads (organization_id, nao_comercial_em desc)
  where nao_comercial_em is not null;
