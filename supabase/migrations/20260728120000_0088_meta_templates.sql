-- 0088 — `meta_templates`: a definição do template para de ser suposta.
--
-- Por que a tabela existe: o template vive NA META, e o contrato de parâmetros
-- dele é derivado da definição (lib/channels/meta/template-contract.ts). Sem uma
-- cópia local não há como (a) montar a tela sem uma chamada à Graph API por
-- render, (b) detectar que o template MUDOU desde que alguém o configurou, nem
-- (c) manter a config apontando para uma versão conhecida. As três são a Fase 3a.
--
-- O que esta tabela NÃO é: fonte da verdade. A Meta é. Esta é uma projeção
-- sincronizada, e `synced_at` diz de quando. Quem ler daqui e concluir que pode
-- editar um template escrevendo nesta tabela está enganado — a escrita é o sync.
--
-- ── (name, language) é a CHAVE, nunca só name ─────────────────────────────
-- `pt_BR` e `pt` são templates DISTINTOS na Meta, com corpos distintos e
-- contagens de parâmetro distintas. Chavear só por nome faria a config de um
-- idioma resolver para o corpo do outro — e o erro apareceria como
-- "(#132000) Number of parameters does not match", em produção, no envio.
--
-- ── `status` fica SEM CHECK, e isso é DECISÃO ─────────────────────────────
-- É vocabulário ABERTO da Meta: ela pode introduzir um estado novo a qualquer
-- momento, e o sync o gravaria. Com CHECK, o INSERT falharia e o `update.sh` de
-- um clone quebraria — o que a doutrina de migrations do repo proíbe
-- explicitamente. Mesmo raciocínio de `crm_lead_activities.type` (ver o cabeçalho
-- de tests/invariants/vocabulario-banco-x-typescript.test.ts, que cobre APENAS
-- colunas que JÁ têm CHECK). O vocabulário conhecido vive no TypeScript.
--
-- ── `parameter_format` TEM CHECK, e isso também é decisão ────────────────
-- Diferente de `status`: o valor gravado aqui NÃO é o que a Meta mandou, é o que
-- `deriveTemplateContract` normalizou (`=== 'NAMED' ? 'NAMED' : 'POSITIONAL'`).
-- É vocabulário NOSSO, fechado em dois, e escrito por um único emissor tipado —
-- então o CHECK move para o INSERT um erro que só apareceria no envio.
-- ⚠️ Obrigação de registro: a convenção do repo manda um par
-- (tabela, coluna) → (arquivo, símbolo) em vocabulario-banco-x-typescript.test.ts.
-- Esse arquivo é congelado pelo hook loop/hooks/freeze-invariants.sh e a Task 6
-- da fase anterior deliberadamente não usou o escape. O par
-- (meta_templates, parameter_format) → (lib/channels/meta/template-contract.ts,
-- ParameterFormat) fica registrado em INBOX-004 junto com o pendente anterior.
--
-- ── Template que some da Meta NÃO é apagado ──────────────────────────────
-- Vira `status='DISABLED'` no sync. Apagar quebraria em silêncio toda config que
-- aponta para ele; marcar transforma o problema em item visível na tela
-- (invariante 6 do sistema vivo: toda configuração tem superfície).

create table if not exists public.meta_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null,
  name text not null,
  language text not null,
  status text not null,                 -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED
  category text,
  rejected_reason text,
  quality_score text,
  -- Payload de `components` como a Meta o devolveu. É a ENTRADA de
  -- deriveTemplateContract; guardar o derivado seria a segunda fonte da verdade
  -- que esta fase inteira existe para eliminar.
  components jsonb not null,
  -- sha256 do contrato DERIVADO (não do jsonb cru): muda quando parâmetro muda,
  -- não muda quando alguém corrige uma vírgula no texto.
  contract_hash text not null,
  parameter_format text not null default 'POSITIONAL',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.meta_templates
    add constraint meta_templates_parameter_format_check
    check (parameter_format in ('POSITIONAL', 'NAMED'));
exception when duplicate_object then null; end $$;

-- COMMENTs ficam no banco: aparecem em `\d+` e no Supabase Studio, onde quem
-- inspeciona a tabela não tem este arquivo à mão.
comment on table public.meta_templates is
  'Espelho local dos templates hospedados na Meta (migration 0088). Derivado, nunca autoritativo: o schema vive na Meta. contract_hash sai de lib/channels/meta/contract-hash.ts e é a âncora da trava por obsolescência.';
comment on column public.meta_templates.status is
  'Vocabulário ABERTO da Meta — deliberadamente SEM CHECK (ela cria estado novo sem avisar; CHECK quebraria o update.sh do clone). Espelhado em lib/channels/meta/template-sync.ts.';
comment on column public.meta_templates.contract_hash is
  'SHA-256 do contrato DERIVADO (slots + parameter_format), não do JSON cru. Config de disparo guarda este hash; divergência = config obsoleta.';
comment on column public.meta_templates.parameter_format is
  'Valor NORMALIZADO por deriveTemplateContract, não o cru da Meta — por isso TEM CHECK, ao contrário de status.';

create unique index if not exists meta_templates_org_waba_name_lang_uniq
  on public.meta_templates (organization_id, waba_id, name, language);

-- `name` no fim serve a listagem ordenada da tela sem sort extra (índice dele,
-- superset do meu — combinado em vez de escolhido).
create index if not exists meta_templates_org_status_idx
  on public.meta_templates (organization_id, status, name);

alter table public.meta_templates enable row level security;

drop policy if exists tenant_isolation_meta_templates_all on public.meta_templates;
create policy tenant_isolation_meta_templates_all on public.meta_templates
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
