-- manifest: crm_materiais + crm_materiais_do_agente e o bucket privado crm-materiais — o material CADASTRADO da empresa que o agente envia na conversa pelo caminho de mídia que já existe (#4129). A tela de cadastro NÃO entra nesta fatia: a linha e o arquivo, com leitura por URL assinada curta e escrita só pelo servidor.
--
-- 9222 — o material da empresa (#4129, fatia "envio sob demanda").
--
-- O agente já manda FOTO DE PRODUTO pelo caminho de mídia do handler
-- (`lib/agent-engine/agent/fotos-do-produto.ts`, 0390). O material é a mesma
-- ideia um degrau acima: em vez de uma foto do catálogo, um DOCUMENTO pronto da
-- empresa (catálogo em PDF, tabela de preços, ficha técnica) que o agente envia
-- quando a conversa pede. O freio não é o arquivo: é QUEM pode enviar o quê, e
-- quando.
--
-- ─── Por que uma TABELA e não um array no agente ─────────────────────────────
--
-- A foto mora no array `catalog_products.fotos` porque a foto É do produto:
-- some com ele, e a ordem é a da tela. Material não é de nenhum produto e pode
-- ser ligado a MAIS DE UM agente — a relação é N:N, e um array em
-- `ai_agents`/`ai_agent_versions` obrigaria a duplicar o mesmo caminho de
-- Storage em cada agente que o envia. `crm_materiais_do_agente` é a lista, e é
-- ela que a ferramenta do turno consulta.
--
-- `agent_id` aponta para o AGENTE, não para a versão: o que a versão publicada
-- congela é `tool_ids`/config, e a lista de materiais é do agente — como o
-- catálogo de produtos é da organização. Agente apagado leva a ligação;
-- material apagado idem (cascata nos dois lados).
--
-- ─── O caminho é DESTA organização, e o CHECK prova ──────────────────────────
--
-- `storage_path` é `<organization_id>/<uuid>.<ext>`. Quem LÊ o caminho (a cópia
-- por service role no turno, a assinatura na tela) confere de novo em TypeScript
-- (`lib/materiais/materiais.ts`) — a coluna é gravável pelo PostgREST por um
-- `manager`, e a leitura do arquivo é por service role, que não tem RLS para
-- barrar. O CHECK é a segunda camada, não a única: barra a linha nascida torta
-- antes de ela existir.
--
-- ─── Bucket PRIVADO, sem policy em storage.objects ───────────────────────────
--
-- `crm-materiais`, privado, 50 MB e a MESMA allowlist de MIME do upload do
-- Inbox (`DOCUMENT_MIMES` de `lib/messaging/media/upload-validation.ts` + as
-- imagens que a régua de tipo conhece). Nenhuma policy em `storage.objects`: só
-- o `service_role` lê e grava, depois de a rota/servidor conferir o papel —
-- molde do `catalog-photos` (0390) e do `brand-logos` (0158). O cliente vê o
-- arquivo por URL ASSINADA CURTA, como `whatsapp-media` já faz.
--
-- Quando o agente envia, o app COPIA o arquivo para
-- `whatsapp-media/<org>/<conversa>/material-<arquivo>` — é essa cópia que a
-- conversa possui, que o Inbox mostra e que a LGPD apaga com a conversa. O
-- material não perde nada, e NÃO entra no RAG: ele é ENVIADO, não lido.
--
-- Idempotente: `create table if not exists`, policies recriadas com
-- `drop ... if exists`, bucket com `on conflict do update`.
-- ============================================================================

create table if not exists public.crm_materiais (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O nome que a TELA e o MODELO leem. Vazio não serve: material sem nome não
  -- pode ser escolhido por ninguém.
  nome text not null check (length(btrim(nome)) between 1 and 200),
  -- Caminho no bucket crm-materiais: SEMPRE `<organization_id>/<uuid>.<ext>`.
  storage_path text not null,
  mime text not null check (length(btrim(mime)) between 1 and 160),
  -- Bytes do arquivo. Positivo: arquivo vazio não é material. O teto é o do
  -- bucket (50 MB) e o do upload do Inbox — repetido aqui porque a linha pode
  -- ser gravada por fora da rota de upload.
  tamanho bigint not null check (tamanho > 0 and tamanho <= 52428800),
  -- A FRASE para a IA: quando este material deve ser enviado. É o que a
  -- descrição da ferramenta mostra ao modelo, ao lado do id.
  quando_enviar text not null default '',
  -- Legenda sugerida (o texto que acompanha o documento no WhatsApp). O modelo
  -- escreve o `body`; esta coluna é o texto que a empresa já deixou pronto.
  legenda text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_materiais_caminho_da_organizacao
    check (storage_path like organization_id::text || '/%'),
  constraint crm_materiais_caminho_unico unique (organization_id, storage_path)
);

comment on table public.crm_materiais is
  'Material pronto da empresa (catálogo em PDF, tabela de preços, ficha) que o agente envia na conversa pelo caminho de mídia do handler (#4129). NÃO entra no RAG: é enviado, não lido. A tela de cadastro fica para a fatia seguinte.';
comment on column public.crm_materiais.storage_path is
  'Caminho em storage/crm-materiais, sempre <organization_id>/<uuid>.<ext>. Quem lê confere o prefixo (lib/materiais/materiais.ts) e o CHECK repete a regra no banco: a cópia por service role não tem RLS.';
comment on column public.crm_materiais.quando_enviar is
  'A frase que o modelo lê na descrição de send_message ao lado do id: em que situação este material deve ser enviado (#4129).';

create index if not exists crm_materiais_da_organizacao
  on public.crm_materiais (organization_id, nome)
  where ativo;

drop trigger if exists trg_crm_materiais_updated_at on public.crm_materiais;
create trigger trg_crm_materiais_updated_at
  before update on public.crm_materiais
  for each row execute function public.fn_set_updated_at();

create table if not exists public.crm_materiais_do_agente (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  material_id uuid not null references public.crm_materiais(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_id, material_id)
);

comment on table public.crm_materiais_do_agente is
  'Quais materiais CADA agente pode enviar (#4129). A ferramenta send_message só aceita material_id que esteja aqui E ativo — o mesmo desenho do filtro de dono das fotos do produto.';

create index if not exists crm_materiais_do_agente_por_material
  on public.crm_materiais_do_agente (organization_id, material_id);

-- ── A ligação NÃO atravessa organizações ────────────────────────────────────
--
-- Duas FKs simples deixariam gravar `(org A, agente da org B)` ou
-- `(org A, material da org B)`. A leitura do turno junta por
-- `x.organization_id = m.organization_id`, então a linha torta seria INERTE —
-- mas ficaria lá, e qualquer consulta futura que esquecesse o join por org
-- ligaria o agente de um cliente ao arquivo de outro. O trigger mata a linha
-- na origem, e é barato: só roda no insert.
create or replace function public.fn_crm_materiais_do_agente_da_mesma_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.ai_agents a
     where a.id = new.agent_id and a.organization_id = new.organization_id
  ) then
    raise exception 'crm_materiais_do_agente: agente % não é da organização %', new.agent_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.crm_materiais m
     where m.id = new.material_id and m.organization_id = new.organization_id
  ) then
    raise exception 'crm_materiais_do_agente: material % não é da organização %', new.material_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_materiais_do_agente_da_mesma_org() from public, anon, authenticated;

drop trigger if exists trg_crm_materiais_do_agente_da_mesma_org on public.crm_materiais_do_agente;
create trigger trg_crm_materiais_do_agente_da_mesma_org
  before insert or update on public.crm_materiais_do_agente
  for each row execute function public.fn_crm_materiais_do_agente_da_mesma_org();

-- ── RLS: membro LÊ; escrita só pelo servidor (service role) ──────────────────
--
-- Leitura por membro: a tela futura e o editor de agente precisam listar os
-- materiais da organização. Escrita NÃO: o upload confere bytes, MIME e tamanho
-- no servidor, e uma linha forjada pelo PostgREST apontaria para um arquivo que
-- ninguém conferiu — o mesmo motivo pelo qual `catalog_products.fotos` só é
-- escrito pela rota de upload.
alter table public.crm_materiais enable row level security;
drop policy if exists tenant_isolation_crm_materiais_select on public.crm_materiais;
create policy tenant_isolation_crm_materiais_select on public.crm_materiais
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.crm_materiais from public, anon, authenticated;
grant select on public.crm_materiais to authenticated;
grant all on public.crm_materiais to service_role;

alter table public.crm_materiais_do_agente enable row level security;
drop policy if exists tenant_isolation_crm_materiais_do_agente_select on public.crm_materiais_do_agente;
create policy tenant_isolation_crm_materiais_do_agente_select on public.crm_materiais_do_agente
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.crm_materiais_do_agente from public, anon, authenticated;
grant select on public.crm_materiais_do_agente to authenticated;
grant all on public.crm_materiais_do_agente to service_role;

-- ── O bucket ────────────────────────────────────────────────────────────────
--
-- A allowlist é a MESMA do upload do Inbox (`DOCUMENT_MIMES`) mais as imagens
-- que a régua de tipo conhece. Duas cópias da lista divergiriam em silêncio; por
-- isso os valores aqui saem daquele mapa, e não de um palpite.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'crm-materiais',
  'crm-materiais',
  false,
  52428800,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
