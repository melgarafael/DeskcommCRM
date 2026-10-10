-- 0340 — Módulo instalado: D3 e D6 da ADR-0002 (onda 2, issue #1114)
--
-- Empilhada sobre a 0325 (#1178, onda 1): chama as provisionadoras, que terminam em
-- `fn_proteger_modulo_provisionado()`. Por isso vem DEPOIS dela no timestamp — posição de
-- migration aqui é semântica, não cosmética.
--
-- D3 — instalar um módulo na INSTÂNCIA cria as tabelas dele na hora. O corte é por instalação,
-- não por organização (decisão do dono, aceite da ADR-0002).
-- D6 — reaplicar nas atualizações é explícito e falha alto.
--
-- O QUE NÃO ESTÁ AQUI: a provisionadora de um módulo concreto. Nenhum módulo com tabelas está na
-- main; o primeiro (financeiro/comanda) escreve o próprio corpo. Até lá, a lista de módulos
-- instaláveis é VAZIA em todo banco de cliente, e o mecanismo é provado por um módulo de teste
-- que só existe na bateria de invariantes.
--
-- Desenho completo: docs/specs/modulo-instalado-onda-2.md.

-- ── 1. O registro da instância ───────────────────────────────────────────────
create table if not exists public.modulos_instalados (
  modulo text primary key check (modulo ~ '^[a-z][a-z0-9_]{1,40}$'),
  estado text not null default 'ativo' check (estado in ('ativo', 'suspenso')),
  instalado_em timestamptz not null default now(),
  instalado_por uuid references auth.users(id) on delete set null,
  reaplicado_em timestamptz,
  motivo_suspensao text
);
comment on table public.modulos_instalados is
  'Módulos opcionais instalados NA INSTÂNCIA (ADR-0002, D3). Sem organization_id: o corte é por instalação. Escrito só por fn_modulo_instalar e fn_reaplicar_modulos_instalados.';

alter table public.modulos_instalados enable row level security;
revoke all on public.modulos_instalados from anon, authenticated;

-- ── 2. O recibo mora no mesmo livro das extensões ────────────────────────────
-- Um tipo novo, `module_install`, em vez de um segundo livro: a instalação passa "pelo mesmo
-- caminho já provado das extensões" (ADR-0002, D3) — chave idempotente, `applied_now`, e a tela
-- de recibos que já existe. É recibo de PLATAFORMA (organization_id nulo), o que a restrição de
-- escopo já aceita sem mudança.
alter table public.extension_operations drop constraint if exists extension_operations_kind_check;
alter table public.extension_operations add constraint extension_operations_kind_check
  check (kind in ('catalog_admission','install','update','revert','removal','configure','module_install'));

-- ── 3. A porta de instalação ─────────────────────────────────────────────────
create or replace function public.fn_modulo_instalar(p_actor uuid, p_operation uuid, p_modulo text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind', 'module_install', 'actor', p_actor, 'modulo', p_modulo);
  v_op public.extension_operations;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_modulo is null or p_modulo !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception using errcode = 'P0001', message = 'extension_invalid_input';
  end if;

  -- A mesma trava das extensões: serializa com instalar/atualizar pacote E com a atualização do
  -- núcleo. O ator é conferido de novo depois dela, porque a autoridade pode ter mudado na espera.
  perform pg_advisory_xact_lock(255, 1);
  perform public.fn_extensions_assert_actor(p_actor);

  select * into v_op from public.extension_operations where id = p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode = 'P0001', message = 'extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;

  -- A lista de módulos instaláveis é o conjunto de provisionadoras que EXISTEM. Não há segunda
  -- lista para divergir: um módulo oficial entra pela tripla migration + baseline + MANIFEST
  -- trazendo `fn_<modulo>_provisionar()`, e o invariante da onda 1 prova a forma dela.
  if to_regprocedure(format('public.fn_%s_provisionar()', p_modulo)) is null then
    raise exception using errcode = 'P0001', message = 'extension_module_unknown';
  end if;

  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode = 'P0001', message = 'extension_core_update_in_progress';
  end if;

  -- O nome só chega aqui depois de passar pelo slug e pela existência da função; `%I` o cita.
  execute format('select public.%I()', 'fn_' || p_modulo || '_provisionar');

  insert into public.modulos_instalados (modulo, estado, instalado_por, reaplicado_em)
    values (p_modulo, 'ativo', p_actor, now())
    on conflict (modulo) do update
      set estado = 'ativo', motivo_suspensao = null, reaplicado_em = now();

  insert into public.extension_operations
      (id, kind, status, actor_id, name, request_fingerprint, request, result)
    values
      (p_operation, 'module_install', 'completed', p_actor, p_modulo,
       public.fn_extensions_fingerprint(v_request), v_request, jsonb_build_object('modulo', p_modulo))
    returning * into v_op;

  -- Tabela criada em tempo de execução é INVISÍVEL para a API até o PostgREST recarregar o
  -- schema. Sem isto, "instalar e usar, sem espera" (condição 3 do dono) seria falso: o módulo
  -- estaria instalado e o app receberia 404 ao consultá-lo. A notificação sai no commit.
  perform pg_notify('pgrst', 'reload schema');

  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_modulo_instalar(uuid, uuid, text) from public, anon;
revoke execute on function public.fn_modulo_instalar(uuid, uuid, text) from authenticated;
grant execute on function public.fn_modulo_instalar(uuid, uuid, text) to service_role;

-- ── 4. A reaplicação nas atualizações (D6) — dois comandos, de propósito ─────
-- O kit aplica o baseline SEM transação única (`psql -f`) e trata como falha toda linha ERROR
-- que não case com a lista de benignos (`already exists` e afins, em _common.sh). Então:
--   A) captura a falha de cada módulo e o marca `suspenso` SEM relançar — o comando se confirma
--      sozinho e a marca PERSISTE;
--   B) se há módulo suspenso, levanta um ERROR com texto próprio, que o update.sh já reporta.
-- Num comando só, relançar desfaria a marca; não relançar deixaria o kit dizer "atualizado".
create or replace function public.fn_reaplicar_modulos_instalados()
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in select modulo from public.modulos_instalados order by modulo loop
    begin
      if to_regprocedure(format('public.fn_%s_provisionar()', r.modulo)) is null then
        raise exception 'a provisionadora de % não existe nesta versão', r.modulo;
      end if;
      execute format('select public.%I()', 'fn_' || r.modulo || '_provisionar');
      update public.modulos_instalados
        set estado = 'ativo', motivo_suspensao = null, reaplicado_em = now()
        where modulo = r.modulo;
    exception
      -- Disputa de trava com o app no ar NÃO é defeito do módulo: relançar desfaz esta
      -- passada inteira (nenhum módulo é marcado), e o texto do Postgres — "deadlock
      -- detected", "could not obtain lock" — é o que o kit reconhece como disputa e o faz
      -- aplicar de novo. Suspender aqui tiraria do ar um módulo que só precisava esperar.
      when deadlock_detected or serialization_failure or lock_not_available then
        raise;
      when others then
        update public.modulos_instalados
          set estado = 'suspenso', motivo_suspensao = sqlerrm
          where modulo = r.modulo;
    end;
  end loop;
  perform pg_notify('pgrst', 'reload schema');
end $$;

create or replace function public.fn_conferir_modulos_instalados()
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_suspensos text;
begin
  select string_agg(modulo, ', ' order by modulo) into v_suspensos
    from public.modulos_instalados where estado = 'suspenso';
  -- A mensagem NÃO repete o erro original, e isso é o ponto: se a provisionadora falhou com
  -- "already exists" e o texto viesse junto, a linha casaria com a lista de erros benignos do
  -- kit e seria ENGOLIDA — exatamente o silêncio que esta função existe para impedir. O motivo
  -- fica em modulos_instalados.motivo_suspensao; o aviso só nomeia o módulo.
  if v_suspensos is not null then
    raise exception 'modulo suspenso na atualizacao: % — o motivo esta em modulos_instalados.motivo_suspensao', v_suspensos;
  end if;
end $$;

revoke execute on function public.fn_reaplicar_modulos_instalados() from public, anon, authenticated, service_role;
revoke execute on function public.fn_conferir_modulos_instalados() from public, anon, authenticated, service_role;

-- Na cadeia de migrations, a reaplicação roda aqui (sem módulos, é vazia). Cada módulo futuro
-- chama a própria provisionadora na migration dele.
do $f$ begin perform public.fn_reaplicar_modulos_instalados(); end $f$;
do $f$ begin perform public.fn_conferir_modulos_instalados(); end $f$;
