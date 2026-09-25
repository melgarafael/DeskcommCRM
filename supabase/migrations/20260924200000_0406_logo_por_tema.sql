-- 0406 — Logo opcional para o tema escuro, preservando o logo padrão.
-- Aditiva: código anterior continua usando logo_path; rollback de imagem não
-- exige apagar coluna, arquivos ou dados. Somente a rota de logo escreve os caminhos.

alter table public.platform_branding add column if not exists logo_dark_path text;
update public.platform_branding set logo_dark_path = null
 where logo_dark_path is not null
   and logo_dark_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';
alter table public.platform_branding drop constraint if exists platform_branding_logo_dark_path;
alter table public.platform_branding add constraint platform_branding_logo_dark_path check (
  logo_dark_path is null or
  logo_dark_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
);
comment on column public.platform_branding.logo_dark_path is
  'Logo opcional para fundo escuro, sem moldura branca. Caminho em brand-logos; null conserva o comportamento do logo padrão.';

create or replace function public.fn_definir_logo_por_tema_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_path  text,
  p_tema  text
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_path   text;
  v_campo text;
begin
  if p_org is null or p_actor is null then
    raise exception 'logo_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  if p_tema is null or p_tema not in ('claro', 'escuro') then
    raise exception 'logo_tema_invalido' using errcode = '22023';
  end if;
  v_campo := case when p_tema = 'escuro' then 'logo_dark_path' else 'logo_path' end;

  v_path := nullif(btrim(coalesce(p_path, '')), '');

  -- O PREFIXO ASSEVERADO DENTRO DO BANCO — o gate que sobrevive ao segundo
  -- chamador. A rota monta o caminho a partir da organização resolvida do
  -- cookie, mas "a rota monta certo" é promessa de UM chamador. Sem esta linha,
  -- um caminho de outro escopo (o `platform/...` que qualquer pessoa lê no HTML
  -- da tela de login) entraria como logo da organização — e o delete-on-replace
  -- da rota, rodando como `service_role`, apagaria o logo da instalação inteira
  -- na troca seguinte.
  if v_path is not null
     and v_path !~ ('^' || p_org::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$')
  then
    raise exception 'logo_da_organizacao_caminho_fora_do_escopo'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'logo_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  -- Merge no CAMPO. `jsonb_set` direto em '{branding,logo_path}' NÃO serviria:
  -- com `branding` ausente, `create_missing` só cria a ÚLTIMA chave e o caminho
  -- intermediário faltando devolve o jsonb original intocado — silenciosamente.
  update public.organizations o
     set settings = case
           when v_path is null
             then jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb) - v_campo, true)
           else jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb)
                      || jsonb_build_object(v_campo, v_path), true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

create or replace function public.fn_definir_logo_da_organizacao(
  p_org uuid, p_actor uuid, p_path text
) returns integer language sql volatile security invoker
set search_path to 'public', 'pg_temp'
as $$
  select public.fn_definir_logo_por_tema_da_organizacao(p_org, p_actor, p_path, 'claro');
$$;

create or replace function public.fn_definir_marca_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_marca jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_hex    text;
  v_limpar boolean;
begin
  if p_org is null or p_actor is null then
    raise exception 'marca_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  v_limpar := p_marca is null or jsonb_typeof(p_marca) = 'null';

  if not v_limpar and jsonb_typeof(p_marca) <> 'object' then
    raise exception 'marca_da_organizacao_forma_invalida: %', jsonb_typeof(p_marca)
      using errcode = '22023';
  end if;

  v_hex := nullif(p_marca ->> 'accent_hex', '');
  if v_hex is not null and v_hex !~ '^#[0-9a-f]{6}$' then
    raise exception 'marca_da_organizacao_accent_hex_invalido'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'marca_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  -- Nome/cor não podem injetar nem apagar os arquivos, que têm rota própria.
  update public.organizations o
     set settings = case
       when v_limpar
         and coalesce(o.settings #>> '{branding,logo_path}', '') = ''
         and coalesce(o.settings #>> '{branding,logo_dark_path}', '') = ''
       then coalesce(o.settings, '{}'::jsonb) - 'branding'
       else jsonb_set(
       coalesce(o.settings, '{}'::jsonb), '{branding}',
       (case when v_limpar then '{}'::jsonb
             else p_marca - 'logo_path' - 'logo_dark_path' end)
       || jsonb_strip_nulls(jsonb_build_object(
         'logo_path', o.settings #> '{branding,logo_path}',
         'logo_dark_path', o.settings #> '{branding,logo_dark_path}'
       )), true) end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_definir_logo_por_tema_da_organizacao(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_definir_logo_por_tema_da_organizacao(uuid, uuid, text, text) to service_role;
revoke execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text) to service_role;
revoke execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) to service_role;
notify pgrst, 'reload schema';
