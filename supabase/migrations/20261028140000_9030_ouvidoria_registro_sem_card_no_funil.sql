-- manifest: **Módulo de Ouvidoria, fatia 1 da #3611: o REGISTRO.** Cria `ouvidoria_manifestacoes` — uma linha por manifestação recebida, com `protocolo` gerado NO SERVIDOR e único POR ORGANIZAÇÃO, texto, canal, contato opcional, status (`recebida`/`em_analise`/`concluida`) e carimbos. Nada de card no funil: nenhuma coluna, FK, índice ou gatilho desta tabela aponta para `crm_leads`. RLS ligada, leitura só de `admin` (e acima) da própria organização, escrita só `service_role`. Tabela criada DEPOIS do corte de 30/10/2026: os privilégios são concedidos AQUI, explícitos, porque o default ACL da plataforma deixa de valer para tabela nova em `public`. Idempotente; espelho no apêndice do `baseline.sql`, acima da VARREDURA anon.

-- ---- ouvidoria: a manifestação registrada (migration 9030, #3611) ----
--
-- ─── O que esta tabela é ────────────────────────────────────────────────────
--
-- O relato que uma pessoa faz À EMPRESA (reclamação, denúncia, elogio,
-- sugestão) e que precisa de PROTOCOLO próprio para ser respondido — não é
-- oportunidade de venda e não pode virar cartão no funil, que é como o CRM
-- representaria hoje qualquer conversa nova. A #3611 pede o registro próprio,
-- privado, com protocolo; esta é a fatia 1: a LINHA e a LEITURA. Ficam fora,
-- declarados no PR: o fluxo de conversa pelo WhatsApp, os anexos, as
-- notificações por e-mail e a tela de gestão.
--
-- ─── Por que coluna e não `organizations.settings` ──────────────────────────
--
-- A ATIVAÇÃO do módulo é preferência da empresa e mora em
-- `organizations.settings.ouvidoria` (`lib/schemas/settings.ts`), como as
-- demais. A MANIFESTAÇÃO não: é dado com protocolo, prazo e leitura restrita,
-- e jsonb não dá unicidade, nem RLS por linha, nem índice de data.
--
-- ─── O protocolo é do SERVIDOR, por duas cercas ─────────────────────────────
--
-- 1. O `.sql` não aceita protocolo do cliente por construção: o CHECK abaixo
--    só admite a forma que o serviço emite (`OUV-AAAAMMDD-XXXXXXXX`, 8 dígitos
--    hexadecimais maiúsculos). Um INSERT com protocolo digitado à mão é
--    recusado pelo banco, não só ignorado pela camada de cima.
-- 2. O índice único é POR ORGANIZAÇÃO (`organization_id, protocolo`): duas
--    organizações podem ter o mesmo protocolo — o número é da empresa, não da
--    instalação — e a mesma organização não pode ter dois.
--
-- ─── Por que `contact_id` e não nome/telefone em texto ──────────────────────
--
-- O contato é OPCIONAL e, quando existe, é o contato do CRM: uma referência
-- com `on delete set null`, não uma cópia de PII numa tabela sem dono. A
-- decisão de LGPD (manter a manifestação quando o contato é anonimizado) está
-- escrita em `tests/invariants/lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts`,
-- que reprova qualquer FK nova para `contacts` sem decisão.
--
-- ─── Corte de 30/10/2026 ────────────────────────────────────────────────────
--
-- A partir de 30/10 a Supabase deixa de conceder `select/insert/update/delete`
-- de TABELA NOVA em `public` a `anon`/`authenticated`/`service_role` (a
-- migration 9029 devolve o default; este arquivo NÃO depende dela). Por isso os
-- `grant` aqui são explícitos: sem eles a tabela nasceria muda e a leitura
-- responderia `42501 permission denied` em toda instalação criada depois do
-- corte. `authenticated` recebe SÓ `select` — escrita é do `service_role`.
--
-- ─── O que esta fatia NÃO faz ───────────────────────────────────────────────
--
-- Não cria função (nada de RPC de protocolo: quem gera é
-- `lib/ouvidoria/registro.ts`, e o CHECK é quem cobra a forma). Não cria
-- gatilho. Não escreve em `crm_leads` em caminho nenhum — o controle central da
-- issue é medido em `tests/unit/ouvidoria-registro.test.ts`, que reprova
-- qualquer escrita fora de `ouvidoria_manifestacoes`.

create table if not exists public.ouvidoria_manifestacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O protocolo que a pessoa recebe. Forma fechada; gerado no servidor.
  protocolo text not null
    check (protocolo ~ '^OUV-[0-9]{8}-[0-9A-F]{8}$'),
  canal text not null
    check (canal in ('whatsapp', 'web', 'email', 'telefone', 'presencial', 'outro')),
  -- O relato. Piso 1 (manifestação vazia não é manifestação) e teto 20.000
  -- (o mesmo tamanho de um corpo de mensagem longo; acima disso o caso é anexo,
  -- que não é desta fatia).
  texto text not null
    check (char_length(btrim(texto)) between 1 and 20000),
  -- Opcional: quem relatou, quando é alguém do CRM. `set null` preserva a
  -- manifestação (e o protocolo) se a pessoa for apagada ou anonimizada.
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'recebida'
    check (status in ('recebida', 'em_analise', 'concluida')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- O protocolo é da ORGANIZAÇÃO: único dentro dela, independente entre empresas.
create unique index if not exists ouvidoria_manifestacoes_protocolo_org_idx
  on public.ouvidoria_manifestacoes (organization_id, protocolo);
-- A leitura da tela (fatia seguinte) é "as mais recentes desta empresa".
create index if not exists ouvidoria_manifestacoes_org_created_idx
  on public.ouvidoria_manifestacoes (organization_id, created_at desc);
-- O contato, quando existe, é procurado pela ficha.
create index if not exists ouvidoria_manifestacoes_contact_idx
  on public.ouvidoria_manifestacoes (contact_id)
  where contact_id is not null;

alter table public.ouvidoria_manifestacoes enable row level security;

-- Leitura: SÓ `admin` (ou acima) da própria organização. A manifestação é
-- confidencial por definição da issue — "acessíveis apenas às pessoas
-- autorizadas", com a opção de somente administradores; nesta fatia a régua é a
-- mais restritiva das duas, e `fn_role_at_least` já responde falso para quem não
-- é membro, então o cross-tenant cai no mesmo lugar (zero linhas, e a leitura
-- por id devolve 404 em vez de revelar que a linha existe).
drop policy if exists ouvidoria_manifestacoes_admin_select on public.ouvidoria_manifestacoes;
create policy ouvidoria_manifestacoes_admin_select on public.ouvidoria_manifestacoes
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- Sem policy de escrita: o canal (fatia 2) grava com `service_role`. Nenhum
-- `authenticated` insere, altera ou apaga — os `grant` abaixo são a segunda
-- cerca, para a recusa ser `42501` e não "zero linhas".
revoke all on public.ouvidoria_manifestacoes from public, anon, authenticated;
grant select on public.ouvidoria_manifestacoes to authenticated;
grant all on public.ouvidoria_manifestacoes to service_role;

-- O comentário explica a regra no lugar onde a próxima pessoa olha. Dentro da
-- guarda `to_regclass`: num clone sem a tabela, comentar não pode derrubar a
-- atualização.
do $$
begin
  if to_regclass('public.ouvidoria_manifestacoes') is not null then
    comment on column public.ouvidoria_manifestacoes.protocolo is
      'Protocolo da manifestação, GERADO NO SERVIDOR (lib/ouvidoria/registro.ts) — nunca aceito do cliente. Único POR ORGANIZAÇÃO (índice ouvidoria_manifestacoes_protocolo_org_idx); a forma OUV-AAAAMMDD-XXXXXXXX é cobrada pelo CHECK da coluna (9030).';
    comment on column public.ouvidoria_manifestacoes.contact_id is
      'Contato do CRM que relatou, OPCIONAL. on delete set null: apagar ou anonimizar a pessoa NÃO apaga a manifestação nem o protocolo (decisão escrita no catálogo LGPD dos invariantes).';
    comment on column public.ouvidoria_manifestacoes.status is
      'recebida -> em_analise -> concluida. A transição é da tela de gestão (fatia seguinte); esta fatia só grava o estado inicial.';
  end if;
end
$$;

notify pgrst, 'reload schema';
