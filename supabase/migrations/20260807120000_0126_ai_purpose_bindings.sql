-- ============================================================================
-- 0126 — ONDE A ESCOLHA DE MODELO DE CADA PONTO DO SISTEMA PASSA A MORAR.
--
-- O problema: o DeskcommCRM chama modelo em 23 lugares (catalogados em
-- lib/ai/pontos/registro.ts) e a escolha de QUAL modelo estava espalhada por
-- três pilhas que não se falam e por sete variáveis de ambiente. Não havia
-- superfície para configurar, então o operador não conseguia nem descobrir
-- quem usava o quê, nem corrigir quando um ponto falhava.
--
-- Uma linha por (organização, ponto). Ausência de linha = comportamento atual
-- preservado — esta migration não muda o funcionamento de nenhuma instalação
-- existente, só abre a porta para configurar.
--
-- `base_url` nasce aqui, sem consumidor imediato, e isso é deliberado: é o que
-- permite apontar um ponto para um endpoint compatível com a API da OpenAI —
-- OpenRouter hoje, modelo rodando na máquina do próprio cliente amanhã. O
-- roteiro do produto prevê modelos locais especialistas por ponto, e um
-- esquema sem esse campo obrigaria a migrar a tabela de novo.
--
-- `provider` NÃO recebe CHECK. É vocabulário aberto (doutrina de migrations do
-- CLAUDE.md): os três CHECKs de provider que já existem no schema são
-- justamente o que trava a entrada da OpenRouter, e criar um quarto repetiria
-- o erro. O vocabulário vive no TypeScript, e o registry de provider é quem
-- recusa o desconhecido — com erro tipado, não com violação de constraint.
-- ============================================================================

create table if not exists public.ai_purpose_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- id do ponto em lib/ai/pontos/registro.ts (= `purpose` do seam, quando passa por ele)
  purpose text not null,

  provider text not null,

  -- A credencial BYOK escolhida para ESTE ponto. NULL = usar a chave de
  -- plataforma do .env para o provider. Cascade: apagar a credencial apaga o
  -- binding, e o ponto volta ao padrão — em vez de ficar apontando para uma
  -- chave que não existe mais e falhar em toda chamada. A tela avisa antes.
  credential_id uuid references public.ai_provider_credentials(id) on delete cascade,

  model_id text not null,

  -- Endpoint compatível com a API da OpenAI (OpenRouter, gateway próprio,
  -- modelo local). NULL = endpoint canônico do provider.
  base_url text,

  -- Desligar sem perder a configuração: o ponto volta ao padrão e a escolha
  -- fica guardada para quando for religado.
  is_enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Um ponto tem UMA escolha por organização. Sem isto, duas linhas para o
  -- mesmo ponto dariam resolução dependente de ordem — o pior tipo de bug de
  -- configuração, porque muda sozinho.
  constraint ai_purpose_bindings_org_purpose_unique unique (organization_id, purpose)
);

create index if not exists ai_purpose_bindings_org_idx
  on public.ai_purpose_bindings (organization_id);

-- O seam resolve por (org, purpose) a cada chamada; sem este índice parcial a
-- leitura do caminho quente varreria os bindings desligados junto.
create index if not exists ai_purpose_bindings_lookup_idx
  on public.ai_purpose_bindings (organization_id, purpose) where is_enabled;

create index if not exists ai_purpose_bindings_credential_idx
  on public.ai_purpose_bindings (credential_id) where credential_id is not null;

alter table public.ai_purpose_bindings enable row level security;

drop policy if exists tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop trigger if exists ai_purpose_bindings_updated_at on public.ai_purpose_bindings;
create trigger ai_purpose_bindings_updated_at
  before update on public.ai_purpose_bindings
  for each row execute function public.fn_set_updated_at();

comment on table public.ai_purpose_bindings is
  'Migration 0126: qual provedor/credencial/modelo cada ponto do sistema que usa IA deve usar, '
  'por organização. O catálogo dos pontos vive em lib/ai/pontos/registro.ts e o par é vigiado por '
  'tests/unit/pontos-de-ia-completude.test.ts. Ausência de linha = comportamento padrão (variável '
  'de ambiente do ponto, depois organizations.settings.llm).';

comment on column public.ai_purpose_bindings.base_url is
  'Endpoint compatível com a API da OpenAI. NULL = endpoint canônico do provider. Existe para '
  'OpenRouter e para modelo local — o roteiro prevê modelo local especialista por ponto.';

comment on column public.ai_purpose_bindings.credential_id is
  'NULL = usar a chave de plataforma do .env. Cascade no delete: sem credencial o ponto volta ao '
  'padrão, em vez de apontar para chave inexistente e falhar em toda chamada.';
