-- Um terceiro prazo em `organizations.settings.agenda`:
-- `pending_expires_after_minutes`, que é quanto tempo um pedido não confirmado
-- segura o horário.
--
-- POR QUE UMA MIGRATION PARA UM CAMPO DE JSONB: `fn_agenda_settings` não faz
-- merge — ela ENUMERA as chaves aceitas e rejeita qualquer extra
-- (`(p_config - 'a' - 'b') <> '{}'` levanta `agenda_settings_invalid`). Sem
-- recriá-la, a tela salvaria o campo novo e receberia 22023, e o operador veria
-- "não foi possível alterar os prazos" sem entender por quê.
--
-- ⚠️ O CAMPO NOVO É OPCIONAL, e isso não é preguiça de validação: toda
-- organização já instalada tem `settings.agenda` com DUAS chaves. Se a função
-- passasse a exigir três, o PATCH da tela de prazos — que ainda pode vir de uma
-- aba aberta antes da atualização — quebraria para todo mundo. Ausente significa
-- "use o default", que o lado TypeScript resolve em `agendaSettingsSchema`
-- (1440 minutos).
--
-- Idempotente por `create or replace`. Não toca em dado nenhum: nenhuma
-- organização precisa de backfill, porque a ausência da chave já é um estado
-- válido e com significado.
--
-- ⚠️ ESTE CORPO É DERIVADO DA VERSÃO EM VIGOR, NÃO REESCRITO A PARTIR DA
-- ORIGINAL. A função ganhou um portão de MFA na migration 0229
-- (`0229_mfa_e_lgpd_agenda`), e partir do corpo antigo o apagaria: `create or
-- replace` troca a definição inteira e não avisa o que sumiu. O estrago passa
-- do teste — o apêndice do `baseline.sql` repete o mesmo corpo, e o `update.sh`
-- de quem já rodava REMOVERIA a proteção que ele tinha. A verificação
-- migration↔baseline não pega: o espelho fica fiel, carregando o defeito.
-- Vigiado por `tests/unit/mfa-nao-some-em-funcao-recriada.test.ts`.

create or replace function public.fn_agenda_settings(p_org uuid, p_config jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null
     or not public.fn_role_at_least(p_org, 'manager')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'agenda_settings_forbidden' using errcode = '42501';
  end if;

  -- Portão de MFA (migration 0229). Prazos de agenda são configuração que muda
  -- o comportamento do produto para a organização inteira.
  if not public.fn_session_mfa_proven() then
    raise exception 'agenda_mfa_required' using errcode = '42501';
  end if;

  if jsonb_typeof(p_config->'confirmation_delay_minutes') is distinct from 'number'
     or jsonb_typeof(p_config->'unknown_protection_minutes') is distinct from 'number'
     -- A subtração das TRÊS chaves conhecidas: o que sobrar é campo que esta
     -- função não reconhece, e aceitar um desses gravaria configuração que
     -- nenhum leitor lê.
     or (p_config - 'confirmation_delay_minutes'
                  - 'unknown_protection_minutes'
                  - 'pending_expires_after_minutes') <> '{}'::jsonb
     or (p_config->>'confirmation_delay_minutes' ~ '^[0-9]{1,5}$') is not true
     or (p_config->>'unknown_protection_minutes' ~ '^[0-9]{1,5}$') is not true
     or (p_config->>'confirmation_delay_minutes')::int not between 1 and 10080
     or (p_config->>'unknown_protection_minutes')::int not between 1 and 10080
     or (p_config->>'unknown_protection_minutes')::int
        < (p_config->>'confirmation_delay_minutes')::int
  then
    raise exception 'agenda_settings_invalid' using errcode = '22023';
  end if;

  -- O terceiro prazo só é validado quando VEM. O piso de 15 minutos existe
  -- porque abaixo disso a expiração corre com quem está decidindo naquele
  -- instante — o pedido sumiria da frente de quem ia confirmá-lo.
  if p_config ? 'pending_expires_after_minutes' then
    if jsonb_typeof(p_config->'pending_expires_after_minutes') is distinct from 'number'
       or (p_config->>'pending_expires_after_minutes' ~ '^[0-9]{1,5}$') is not true
       or (p_config->>'pending_expires_after_minutes')::int not between 15 and 10080
    then
      raise exception 'agenda_settings_invalid' using errcode = '22023';
    end if;
  end if;

  update public.organizations
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{agenda}', p_config, true)
   where id = p_org;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;
  return p_config;
end; $$;

-- As DUAS origens de EXECUTE, como manda a doutrina de migrations: o grant que
-- o Postgres dá a PUBLIC ao criar, e o `alter default privileges ... to anon`
-- do baseline, que alcança toda função criada depois dele.
revoke all on function public.fn_agenda_settings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_agenda_settings(uuid, jsonb) to authenticated;
