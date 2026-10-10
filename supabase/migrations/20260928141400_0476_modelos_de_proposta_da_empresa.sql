-- 20260928015000_0476_modelos_de_proposta_da_empresa.sql
-- 0476 — a empresa cadastra os próprios modelos de proposta (spec de
-- 26/09/2026, item 5).
--
-- 1. `nome` e `descricao`: a tabela nasceu na M0 só com slug/versão/seções,
--    sem nada que uma PESSOA leia. Os modelos da plataforma têm nome no código
--    (ROTULO_DO_MODELO); os da empresa precisam guardar o seu.
-- 2. Escrita só de `manager`+ (D9 da spec; decisão #10 da spec de 21/09:
--    "revisar/alterar proposta só manager+"). A M0 abriu para `agent`, e com a
--    tela nova um atendente reescreveria pela API REST o texto que vai para
--    todo cliente. Nenhum código escreve nesta tabela como `agent` (medido:
--    só `lib/propostas/modelos/resolver.ts` a lia até este plano).
--
-- Aditiva e idempotente; sem backfill (nome nulo cai no rótulo do código).

alter table public.proposal_templates add column if not exists nome text;
alter table public.proposal_templates add column if not exists descricao text;

comment on column public.proposal_templates.nome is
  'Nome do modelo para uma pessoa ler. Nulo numa cópia de modelo da plataforma = usa o rótulo do código (ROTULO_DO_MODELO).';
comment on column public.proposal_templates.descricao is
  'Para que serve este modelo, em uma frase. Opcional.';

drop policy if exists proposal_templates_write on public.proposal_templates;
create policy proposal_templates_write on public.proposal_templates
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));
