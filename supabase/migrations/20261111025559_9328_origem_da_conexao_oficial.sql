-- manifest: **A conexão oficial passa a registrar DE ONDE nasceu (#4074).** `channel_sessions` ganha `meta_connection_origin` (`embedded_signup` | `token_manual`), nula nas linhas anteriores a esta migration — que, por construção, vieram do formulário de token colado à mão. A coluna entra no gatilho `fn_channel_sessions_ligacao_ao_provedor_e_do_servidor` (9093/9104): `anon`/`authenticated` não declaram procedência; quem grava é a rota do servidor, pelo service role. Aditiva e idempotente, sem backfill (nulo é a resposta honesta para o que ninguém registrou) e sem mudar nenhum caminho existente.
--
-- 9328 — a origem da conexão oficial é dado do servidor.
--
-- ═══ Por quê ═══
--
-- A #4074 abre uma SEGUNDA porta para o número oficial: a janela da Meta
-- (Embedded Signup) com o app da própria instalação. As duas portas gravam a
-- MESMA linha de `channel_sessions`, e até aqui nada distinguia uma da outra.
-- Sem procedência, um canal que nasceu de um token que expira em 60 dias fica
-- idêntico a um que nasceu de consentimento renovável — na tela e na auditoria.
--
-- Esta migration entrega só o LADO DO ESTADO. Não há chamada à Meta aqui, e o
-- código que troca o código do Embedded Signup por token não existe ainda: ele
-- depende de `app_id`/`config_id` do app da instalação, que a #4074 ainda vai
-- decidir onde guardar. O que se prova sem credencial de terceiro é que a porta
-- manual registra a origem DELA, e que ninguém mais consegue declará-la.
--
-- ═══ Por que nula, e não backfill para 'token_manual' ═══
--
-- A coluna nasce sem default e sem UPDATE de backfill. Toda linha que existe
-- hoje nasceu do formulário, então `token_manual` seria verdade — mas é verdade
-- INFERIDA, e a leitura (`lib/channels/meta/origem-da-conexao.ts`) já a marca
-- como `inferida: true`. Backfill transformaria inferência em registro, e a
-- partir daí ninguém distinguiria "nasceu do formulário" de "a 9328 carimbou".
--
-- ═══ Por que a coluna entra no gatilho da 9104 ═══
--
-- `channel_sessions` tem GRANT ALL para `authenticated`, e as policies deixam o
-- admin da organização escrever a própria linha direto pela API do banco. A
-- origem diz com que porta a instalação falou com a Meta; se o cliente pudesse
-- escrevê-la, um canal com token colado à mão se declararia Embedded Signup e a
-- tela mentiria. É a MESMA regra da 9093/9104, na mesma tabela e no mesmo
-- momento do gatilho — por isso a função é substituída inteira, e não nasce uma
-- segunda (duas leituras de `current_user` por linha, dois lugares para lembrar
-- a cada coluna nova).

alter table public.channel_sessions
  add column if not exists meta_connection_origin text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_meta_connection_origin_check'
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_meta_connection_origin_check
      check (
        meta_connection_origin is null
        or meta_connection_origin in ('embedded_signup', 'token_manual')
      );
  end if;
end $$;

comment on column public.channel_sessions.meta_connection_origin is
  'De onde nasceu a conexão oficial (#4074): embedded_signup | token_manual. Nulo = linha anterior à 9328, que só podia ter vindo do formulário.';

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
       or new.zernio_webhook_id is not null
       -- 9104: a credencial do número oficial também é do servidor.
       or new.meta_token_encrypted is not null
       or new.meta_phone_number_id is not null
       or new.meta_waba_id is not null
       -- 9328: e a PROCEDÊNCIA da conexão também.
       or new.meta_connection_origin is not null then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.zernio_credencial_da_instalacao, new.zernio_account_id, new.zernio_profile_id, new.zernio_webhook_id)
       is distinct from
     (old.zernio_credencial_da_instalacao, old.zernio_account_id, old.zernio_profile_id, old.zernio_webhook_id)
     -- 9104: a credencial do número oficial também é do servidor.
     or (new.meta_token_encrypted, new.meta_phone_number_id, new.meta_waba_id, new.meta_connection_origin)
       is distinct from
     (old.meta_token_encrypted, old.meta_phone_number_id, old.meta_waba_id, old.meta_connection_origin)
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
