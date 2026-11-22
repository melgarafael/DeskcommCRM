-- 20261122010336_9451 — o negócio sai do follow-up SEM calar o contato, e o
-- motivo do "não comercial" entra na anonimização.
--
-- manifest: O negócio marcado como não comercial sai do follow-up sem calar o contato — a inscrição passa a carregar `lead_id` e o motor consulta ESSE negócio no disparo (`lib/followup/elegibilidade-do-negocio.ts`) — e o motivo do "não comercial" entra na anonimização pelo gatilho `trg_lgpd_redigir_classificacao_comercial`, mantendo `nao_comercial_em`.
--
-- Pai: #4195 (o espelho da classificação está na 9414). Esta migration fecha os
-- itens 2 e 3 do que o mantenedor cobrou na #4191 — os dois que precisam de
-- coluna e de gatilho, e que o TypeScript sozinho não consegue cumprir:
--
--   (2) FOLLOW-UP. `followup_enrollments` nasceu por CONTATO e não tem negócio,
--       então nada no caminho do envio sabia distinguir o card marcado como não
--       comercial do outro negócio aberto da mesma pessoa. A inscrição passa a
--       carregar `lead_id`, e o motor consulta ESSE negócio no disparo
--       (`lib/followup/elegibilidade-do-negocio.ts`). A alternativa — bloquear o
--       contato — silenciaria o negócio vivo, que é o que a issue proíbe.
--
--   (3) LGPD. O motivo é texto escrito pela equipe ("golpe do falso advogado,
--       CPF 123…"): é dado pessoal que a cascata vigente não alcançava, porque
--       ela atualiza `crm_leads` coluna a coluna e o motivo nasceu depois. Um
--       gatilho no contato redige o motivo e a autoria no instante em que o
--       contato é anonimizado — por QUALQUER caminho, não só pela cascata.
--
-- Crédito do desenho original: @leonciojunior
-- (`contrib/4191-negocio-nao-comercial-leoncio`). A forma do gatilho é dele
-- (redigir o motivo sem mexer em `nao_comercial_em`); o marcador e o backfill
-- são desta entrega, que usa texto livre em vez do vocabulário fechado dele.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A INSCRIÇÃO CARREGA O NEGÓCIO
-- ════════════════════════════════════════════════════════════════════════════

alter table public.followup_enrollments
  add column if not exists lead_id uuid;

-- `on delete set null`, não `cascade`: apagar o negócio não pode apagar a
-- inscrição do contato. Sem vínculo, a guarda cai no caminho de legado (envia) —
-- que é o comportamento de antes desta entrega, e o menos destrutivo.
alter table public.followup_enrollments
  drop constraint if exists followup_enrollments_lead_id_fkey;
alter table public.followup_enrollments
  add constraint followup_enrollments_lead_id_fkey
  foreign key (lead_id) references public.crm_leads(id) on delete set null;

-- Parcial porque a maioria das inscrições não tem negócio: o índice só pesa no
-- que existe, e é o que a guarda consulta (`organization_id` + `id` do negócio).
create index if not exists idx_followup_enrollments_lead
  on public.followup_enrollments (organization_id, lead_id)
  where lead_id is not null;

comment on column public.followup_enrollments.lead_id is
  'O NEGÓCIO dono desta inscrição (#4195, migration 9451). Nulo = inscrição anterior à coluna ou fluxo sem negócio: a guarda de cobrança trata como legado e NÃO cala o contato por falta de vínculo.';

-- Backfill: o vínculo já estava gravado na fronteira de atendimento (a demanda
-- da conversa aponta para o negócio dela). Aplicar a MESMA régua do código
-- (`resolverNegocioDaFronteira`): negócio da demanda, da mesma organização, e só
-- quando a demanda é do MESMO contato da inscrição — demanda de outra pessoa não
-- empresta o negócio.
update public.followup_enrollments e
   set lead_id = d.lead_id
  from public.demandas d
 where e.lead_id is null
   and e.service_boundary->>'demanda_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and d.id = (e.service_boundary->>'demanda_id')::uuid
   and d.organization_id = e.organization_id
   and d.contact_id = e.contact_id
   and d.lead_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. LGPD: O MOTIVO E A AUTORIA MORREM COM O CONTATO
-- ════════════════════════════════════════════════════════════════════════════
--
-- Por que GATILHO e não uma linha a mais na cascata: a cascata é um corpo de
-- 400 linhas com duas cópias no baseline, e mexer nela custa um diff que ninguém
-- revisa. Pior: ela é UM dos caminhos. A fusão de fichas (9243), o botão da
-- ficha e o pedido do titular passam por funções diferentes, e um gatilho no
-- `is_anonymized` vale para todos — inclusive para os que ainda não existem.
--
-- O que NÃO se apaga: `nao_comercial_em`. A classificação é elegibilidade, não
-- conteúdo: apagá-la faria o negócio voltar a ser cobrado e a voltar para as
-- métricas comerciais de um contato que pediu para ser esquecido. O texto e a
-- autoria saem; a DECISÃO fica.

create or replace function public.fn_lgpd_redigir_classificacao_comercial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `nao_comercial_motivo` recebe o MARCADOR, não NULL: o CHECK
  -- `crm_leads_nao_comercial_coerente` (9414) exige motivo não vazio quando
  -- `nao_comercial_em` está preenchido, e é essa coluna que mantém o negócio
  -- fora do Radar e dos follow-ups. A tela traduz o marcador
  -- ("Motivo apagado pela anonimização") — ele nunca é mostrado cru.
  update public.crm_leads l
     set nao_comercial_motivo = 'anonimizado',
         nao_comercial_por = null
   where l.contact_id = new.id
     and l.organization_id = new.organization_id
     and l.nao_comercial_em is not null
     and (l.nao_comercial_motivo is distinct from 'anonimizado'
          or l.nao_comercial_por is not null);
  return null;
end;
$$;

comment on function public.fn_lgpd_redigir_classificacao_comercial() is
  'Redige motivo e autoria da classificação não comercial quando o contato é anonimizado (#4195). Mantém nao_comercial_em: a decisão é elegibilidade, não conteúdo.';

revoke all on function public.fn_lgpd_redigir_classificacao_comercial() from public, anon, authenticated;

drop trigger if exists trg_lgpd_redigir_classificacao_comercial on public.contacts;
create trigger trg_lgpd_redigir_classificacao_comercial
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_lgpd_redigir_classificacao_comercial();
