-- manifest: **A credencial do número oficial passa a ser gravada só pelo servidor.** O gatilho `trg_channel_sessions_ligacao_ao_provedor_e_do_servidor` (9093) ganha as colunas `meta_token_encrypted`, `meta_phone_number_id` e `meta_waba_id` de `channel_sessions`: `anon`/`authenticated` recebem 42501 ao gravá-las num INSERT ou alterá-las num UPDATE. Quem as grava é a rota do servidor, pelo service role.
--
-- 9104 — a credencial do número oficial é do servidor, como a ligação com o
-- provedor parceiro na 9093.
--
-- ═══ Por quê ═══
--
-- Estas três colunas dizem com que número e com que token a instalação fala
-- com a Meta em nome da organização. `channel_sessions` tem GRANT ALL para
-- `authenticated`, e as policies de insert/update deixam o admin da
-- organização escrever a própria linha direto pela API do banco. Quem grava
-- essas colunas no produto é só o servidor: a conexão do canal oficial
-- (`app/api/v1/channels/official/route.ts`) e a exclusão do canal
-- (`app/api/v1/channel-sessions/[id]/route.ts`, que zera o token), as duas
-- pelo service role. Nenhum caminho legítimo precisa que o admin as escreva
-- por fora.
--
-- ═══ Por que estender a função da 9093 e não criar outra ═══
--
-- É a mesma regra (a ligação do canal com o provedor é do servidor), na mesma
-- tabela e no mesmo momento do gatilho. Uma segunda função faria duas leituras
-- de `current_user` por linha e dois lugares para lembrar a cada coluna nova.
-- O corpo abaixo é o da 9093 inteiro, mais as três colunas.
--
-- UPDATE compara com `is distinct from`: reescrever o mesmo valor (um PATCH
-- que reenvia a linha) não é alteração e não é recusado. O gatilho em si já
-- existe desde a 9093; só a função muda.

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
       or new.meta_waba_id is not null then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.zernio_credencial_da_instalacao, new.zernio_account_id, new.zernio_profile_id, new.zernio_webhook_id)
       is distinct from
     (old.zernio_credencial_da_instalacao, old.zernio_account_id, old.zernio_profile_id, old.zernio_webhook_id)
     -- 9104: a credencial do número oficial também é do servidor.
     or (new.meta_token_encrypted, new.meta_phone_number_id, new.meta_waba_id)
       is distinct from
     (old.meta_token_encrypted, old.meta_phone_number_id, old.meta_waba_id)
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
