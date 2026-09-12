-- ============================================================================
-- 0234 — CHAMADA DE VOZ NASCE DESLIGADA, E QUEM A LIGA ASSINA O RISCO
--
-- A chamada de voz (spec 18) funciona vinculando um SEGUNDO APARELHO ao mesmo
-- número de WhatsApp que já atende pelo transporte de mensagens — por um
-- caminho que não é o oficial. O risco não é o aparelho ser desconectado: é a
-- CONTA ser bloqueada. Quem paga não é quem clicou; é o negócio inteiro, que
-- fica sem o canal onde vende.
--
-- Um risco desse tamanho não pode ser herdado por atualização. Até aqui a única
-- trava era "ninguém escaneou o QR ainda", e a aba aparecia para todo admin de
-- toda instalação — ou seja, a decisão estava sendo tomada por quem nunca foi
-- perguntado.
--
-- ═══ AUSÊNCIA DE LINHA É "DESLIGADO" — E AQUI ISSO É O CONTRÁRIO DA 0142 ═══
--
-- `org_guardrail_layers` (0142) tem TRÊS estados de propósito: lá, `null` é
-- "não escolheu" e vale o ambiente, porque havia instalações que já tinham
-- decidido aquilo no `.env` e colapsar em `false` desligaria a camada delas no
-- dia do deploy.
--
-- Aqui não existe esse passado: a capacidade é nova, ninguém a tem, e não há
-- decisão anterior a preservar. `false` por ausência é a leitura VERDADEIRA do
-- estado do mundo, não uma perda de informação — e é a condição do dono do
-- produto: ninguém ganha a capacidade por atualizar.
--
-- Copiar os três estados daqui seria copiar a forma sem a razão, e o efeito
-- seria o oposto: `null` cairia num padrão de ambiente, e uma variável de
-- ambiente ligada entregaria a capacidade a todas as organizações da instalação
-- de uma vez — exatamente o que este arquivo existe para impedir.
--
-- ═══ POR QUE UMA TABELA, E NÃO `organizations.settings` ═══
--
-- `app/actions/settings/updateMarcaDaOrganizacao.ts` registra que aquele jsonb
-- já tem três escritores com read-modify-write e perda MEDIDA, e diz por
-- escrito que um quarto escritor com o mesmo padrão seria inaceitável. Uma
-- linha própria com chave primária não tem esse problema por construção.
--
-- ═══ LEITURA ORG-FLAT, ESCRITA DE ADMIN — NO BANCO ═══
--
-- Forma canônica do repo (`crm_stages_select`/`crm_stages_manager_write`), e a
-- lição que a 0143 pagou como forward-fix da 0142: rota NÃO é fronteira. O
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated` do
-- baseline vale para toda tabela criada depois dele — inclusive esta. Sem a
-- policy de papel, um `viewer` ligaria a chamada de voz da organização direto
-- pelo PostgREST com a anon key (que vai para o browser), sem passar pela rota
-- e sem deixar linha de auditoria, porque o `audit()` vive na rota.
--
-- Aqui isso entra de saída, e não como conserto depois.
--
-- ═══ QUEM ACEITOU, E QUANDO ═══
--
-- `risco_aceito_por`/`risco_aceito_em` não são enfeite de auditoria: são a
-- única forma de responder "quem autorizou vincular um segundo aparelho ao
-- número da empresa" depois que a conta for bloqueada. `on delete set null` no
-- ator porque a resposta que importa é a DATA — perder o registro inteiro
-- porque a pessoa saiu da empresa apagaria justamente o rastro do incidente.
-- ============================================================================

create table if not exists public.org_voice_calls (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  risco_aceito_em timestamptz,
  risco_aceito_por uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.org_voice_calls enable row level security;

drop policy if exists org_voice_calls_select on public.org_voice_calls;
drop policy if exists org_voice_calls_admin_write on public.org_voice_calls;

create policy org_voice_calls_select on public.org_voice_calls
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy org_voice_calls_admin_write on public.org_voice_calls
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

-- A anon key vai para o browser. Sem este revoke, o `GRANT ALL ON TABLES TO
-- anon` do baseline deixa a tabela alcançável sem sessão nenhuma.
revoke all on public.org_voice_calls from anon;

drop trigger if exists trg_org_voice_calls_set_updated_at on public.org_voice_calls;
create trigger trg_org_voice_calls_set_updated_at
  before update on public.org_voice_calls
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
