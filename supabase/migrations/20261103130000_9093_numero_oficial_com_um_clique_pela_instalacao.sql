-- manifest: **Número oficial conectado com um clique, pela conta do provedor da instalação.** `channel_sessions` ganha `zernio_profile_id` (o perfil que a instalação criou no provedor para esta organização), `zernio_webhook_id` (a assinatura de webhook que entrega os eventos da conta: na conexão por um clique, o webhook ÚNICO da instalação; na chave própria, o do número) e `zernio_credencial_da_instalacao` (a sessão usa a chave da INSTALAÇÃO, lida na hora, em vez de guardar cópia). O CHECK `channel_sessions_zernio_credencial_unica` impede as duas credenciais ao mesmo tempo. O gatilho `trg_channel_sessions_ligacao_ao_provedor_e_do_servidor` deixa essas colunas (e `zernio_account_id`) só para o servidor, e nas linhas da instalação também telefone, arquivamento, provedor, organização e DELETE: `anon`/`authenticated` recebem 42501.
--
-- ═══ O que o cliente da instalação não conseguia ═══
--
-- Conectar o número pelo provedor parceiro pedia a chave de API e o id da
-- conta no painel do provedor, e depois colar a URL e o segredo do webhook lá.
-- Quem revende a instalação tem a conta do provedor; o cliente dele não tem
-- acesso a ela. Agora a instalação cria um perfil por organização, abre a
-- página de cadastro da Meta do próprio provedor e, na volta, põe o perfil no
-- webhook da instalação — sem nada para colar.
--
-- ═══ Por que um ponteiro e não uma cópia da chave ═══
--
-- Copiar a chave da instalação cifrada em cada sessão faria N cópias do mesmo
-- segredo, e trocar a chave deixaria todas as conexões falando com a antiga.
-- Com o ponteiro, a credencial é resolvida na hora (`lib/channels/zernio/
-- credentials.ts`): trocar a chave da instalação vale para todas, e apagar a
-- organização não deixa cópia para trás.
--
-- ═══ Por que o webhook da conexão por um clique é ÚNICO ═══
--
-- O provedor limita as assinaturas de webhook por conta e recomenda um
-- endpoint para todos os clientes. As conexões por um clique entram por um
-- webhook só da instalação (id e segredo em `platform_config`, filtrado aos
-- perfis das conexões ativas), e `zernio_webhook_id` guarda o id dessa
-- assinatura compartilhada — que a remoção do canal NÃO apaga: só tira o
-- perfil do filtro. Na chave própria, a coluna é a assinatura do número,
-- apagada na remoção.
--
-- ═══ Por que colunas e não o `metadata` ═══
--
-- O `metadata` da sessão é do ingest e do roteamento; um `update` de lá
-- apagaria o perfil e o webhook daqui. É a mesma razão da 0311.
--
-- Idempotente: `add column if not exists`, constraint recriada por nome,
-- `create or replace function` e gatilho recriado por nome. Toda linha
-- existente nasce com `false` e satisfaz o CHECK: não há dado a corrigir. O
-- gatilho só olha escritas novas, então não esbarra em dado nenhum de clone.

alter table public.channel_sessions
  add column if not exists zernio_profile_id text,
  add column if not exists zernio_webhook_id text,
  add column if not exists zernio_credencial_da_instalacao boolean not null default false;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_zernio_credencial_unica;
alter table public.channel_sessions
  add constraint channel_sessions_zernio_credencial_unica
  check (not (zernio_credencial_da_instalacao and zernio_token_encrypted is not null));

comment on column public.channel_sessions.zernio_profile_id is
  'Perfil do provedor parceiro em que a conta foi conectada. Só a conexão por um clique o grava: é por ele que a volta confere que a conta conectada é desta organização, e é ele que entra no filtro do webhook da instalação. Migration 9093.';
comment on column public.channel_sessions.zernio_webhook_id is
  'Assinatura de webhook que entrega os eventos desta conta, registrada pela INSTALAÇÃO. Na conexão por um clique é o webhook ÚNICO da instalação (compartilhado, filtrado aos perfis das conexões ativas; id em platform_config): a remoção do canal tira o perfil do filtro e NÃO apaga a assinatura. Na chave própria é a assinatura do número (filtrada à conta), apagada na remoção. Nulo quando o operador configurou o webhook à mão. Migration 9093.';
comment on column public.channel_sessions.zernio_credencial_da_instalacao is
  'true = a sessão fala com o provedor pela chave da INSTALAÇÃO (platform_config), resolvida na hora; zernio_token_encrypted fica nulo. false = chave própria da organização, cifrada em zernio_token_encrypted. Migration 9093.';

-- ═══ Só o servidor grava a ligação do canal com o provedor ═══
--
-- Estas colunas decidem com que chave e por qual conta a instalação fala com o
-- provedor — e a da instalação alcança todos os números da conta dela. A
-- tabela tem GRANT ALL para `authenticated`, e as policies deixam o admin da
-- organização inserir e alterar a própria linha direto pela API do banco: sem
-- esta trava, a linha diria "use a chave da instalação com a conta X" sem que
-- o servidor tivesse conectado X. Quem as grava é sempre a rota do servidor,
-- pelo service role; `anon` e `authenticated` não as escrevem (42501).
-- Nas linhas da instalação também ficam com o servidor `phone_number` (os
-- eventos de número do provedor são roteados por ele), `archived_at`,
-- `provider`, `organization_id` e o DELETE: arquivar, apagar ou trocar o
-- provedor por fora da rota pularia o passo que desconecta o número da conta
-- da instalação, e desarquivar devolveria ao roteamento um número que pode já
-- ser de outra organização. A rota de exclusão grava essas linhas pelo
-- service role, depois de desfazer no provedor.
--
-- Gatilho e não privilégio por coluna: o GRANT ALL de tabela prevalece sobre
-- um revoke de coluna, e trocá-lo por uma lista de colunas teria de ser
-- lembrado a cada coluna nova. A função não precisa de EXECUTE para disparar.
create or replace function public.fn_channel_sessions_ligacao_ao_provedor_e_do_servidor()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then
    -- `new` é nulo no DELETE: devolvê-lo cancelaria a exclusão do servidor.
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.zernio_credencial_da_instalacao then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.zernio_credencial_da_instalacao
       or new.zernio_account_id is not null
       or new.zernio_profile_id is not null
       or new.zernio_webhook_id is not null then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.zernio_credencial_da_instalacao, new.zernio_account_id, new.zernio_profile_id, new.zernio_webhook_id)
       is distinct from
     (old.zernio_credencial_da_instalacao, old.zernio_account_id, old.zernio_profile_id, old.zernio_webhook_id)
     or (old.zernio_credencial_da_instalacao and
         (new.archived_at, new.provider, new.organization_id, new.phone_number)
           is distinct from
         (old.archived_at, old.provider, old.organization_id, old.phone_number)) then
    raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_channel_sessions_ligacao_ao_provedor_e_do_servidor() from public, anon, authenticated;

drop trigger if exists trg_channel_sessions_ligacao_ao_provedor_e_do_servidor on public.channel_sessions;
create trigger trg_channel_sessions_ligacao_ao_provedor_e_do_servidor
  before insert or update or delete on public.channel_sessions
  for each row execute function public.fn_channel_sessions_ligacao_ao_provedor_e_do_servidor();
