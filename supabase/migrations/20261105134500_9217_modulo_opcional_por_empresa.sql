-- manifest: cria organization_modules — o módulo opcional POR EMPRESA (linha ausente = herda a instalação, que segue sendo o teto); PK (organization_id, modulo), só service_role, sem policy.
--
-- 9217 — O INTERRUPTOR DE MÓDULO PASSA A CABER POR EMPRESA (#3868).
--
-- ── O defeito ────────────────────────────────────────────────────────────────
--
-- Em `/admin/sistema` → "Recursos opcionais" a própria tela dizia o escopo: "Vale
-- para todas as empresas hospedadas aqui". Era literal: ligar `propostas`,
-- `crm_b2b`, `cobranca` ou `setores` ligava para TODAS as organizações do
-- servidor (`platform_config`, 0341). Quem revende não tinha como dar o módulo a
-- um cliente e negar a outro — o único caminho era subir uma instalação por
-- cliente.
--
-- ── O que esta tabela guarda, e o que ela NÃO guarda ─────────────────────────
--
-- A EXCEÇÃO de uma empresa, e só ela. Linha ausente = herda a instalação, que é o
-- comportamento de hoje: quem nunca abriu o bloco "Por empresa" não sente
-- diferença nenhuma. A resolução (`lib/instalacao/modulos.ts`) é:
--
--   1. a linha da empresa vence (`ligado` liga, `desligado` desliga);
--   2. sem linha, herda a instalação;
--   3. instalação desligada vence a linha `ligado`, SEMPRE — o servidor é teto,
--      porque o que o módulo abre (porta de rede, credencial de outro sistema) é
--      decisão de quem responde pelo servidor, não da empresa;
--   4. só o valor `ligado` liga (mesma régua da 0341).
--
-- Módulo de TABELA (ADR-0002: `honorarios`, `financeiro`) NÃO entra aqui: eles já
-- provisionam esquema por instalação (`fn_modulo_instalar`,
-- `fn_financeiro_provisionar`) e desligar por empresa mexeria em dado
-- provisionado. A leitura por empresa ignora essas linhas de propósito (F3 do
-- #3868), e a tela nem as oferece.
--
-- ── Por que NÃO é uma coluna em `organizations.settings` ─────────────────────
--
-- `settings` é jsonb livre, lido por RLS em vários pontos, e escrevê-lo pela tela
-- já reverteu decisão de exposição em silêncio uma vez (ver o bloco da marca em
-- `baseline.sql`). Um mapa de módulos ali teria a mesma forma do defeito: escrita
-- de configuração de servidor por um caminho que o cliente também edita. Tabela
-- própria tem chave, CHECK e grant — e nada mais escreve nela.
--
-- ── Por que SEM policy ───────────────────────────────────────────────────────
--
-- Mesma doutrina de `platform_config` (0341): a linha não responde a "qual é a sua
-- organização?" por JWT — quem decide é o servidor, na sessão que ele mesmo
-- validou. RLS ligada sem policy = ninguém alcança pela REST; o `service_role` a
-- bypassa e só o servidor o usa. Nenhuma função SECURITY DEFINER nova, então a
-- lista congelada de `tests/invariants/hardening-definer-varredura.test.ts` não
-- muda.
--
-- Sem dado tocado, sem backfill: tabela nova e vazia, e vazio = herda. Idempotente
-- (`if not exists`, gatilho recriado por nome), então `update.sh` de clone com
-- dados não tem o que corrigir.

create table if not exists public.organization_modules (
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  modulo          text        not null,
  estado          text        not null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  constraint organization_modules_pkey primary key (organization_id, modulo),
  -- O módulo é um identificador do código (`MODULOS_OPCIONAIS_POR_FLAG`). A lista
  -- fechada mora lá, não aqui: módulo novo não deve exigir migration para a
  -- tabela aceitar a linha, e a linha de um módulo que o código não conhece é
  -- inerte (ninguém a consulta). O CHECK recusa lixo de digitação/script.
  constraint organization_modules_modulo_formato
    check (modulo ~ '^[a-z][a-z0-9_]{2,40}$'),
  -- Os dois únicos estados. `null` não é "herda" — herdar é a AUSÊNCIA da linha;
  -- gravar a linha sem estado deixaria a tela sem como distinguir os dois.
  constraint organization_modules_estado_valido
    check (estado in ('ligado', 'desligado'))
);

comment on table public.organization_modules is
  'Exceção de módulo opcional POR ORGANIZAÇÃO (migration 9217, issue #3868). Linha ausente = herda a instalação (platform_config, 0341). Instalação desligada vence a linha `ligado`: o servidor é teto. Só módulos por FLAG — honorarios/financeiro (módulos de tabela, ADR-0002) não valem aqui. Lida por lib/instalacao/modulos.ts e escrita por app/actions/settings/updateModuloDaEmpresa.ts; service_role apenas, sem policy.';

comment on column public.organization_modules.estado is
  'ligado = a empresa tem o módulo (desde que a instalação também tenha); desligado = a empresa não tem, mesmo com a instalação ligada. Nunca apaga dado: é só a decisão de leitura.';

comment on column public.organization_modules.updated_by is
  'Quem trocou, para a trilha de auditoria (a ação também grava em audit()). Nulo em escrita de script.';

-- ZERO POLICIES, DE PROPÓSITO — ver o cabeçalho desta migration.
alter table public.organization_modules enable row level security;

-- As DUAS origens de grant, como na 0341: o `alter default privileges ... to anon`
-- do baseline alcança toda tabela criada depois dele, e o dono também tem grant
-- próprio. Tratar só uma deixa a tabela exposta com o gate verde.
revoke all on public.organization_modules from public, anon, authenticated;
grant select, insert, update, delete on public.organization_modules to service_role;

drop trigger if exists trg_organization_modules_touch on public.organization_modules;
create trigger trg_organization_modules_touch
  before update on public.organization_modules
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
