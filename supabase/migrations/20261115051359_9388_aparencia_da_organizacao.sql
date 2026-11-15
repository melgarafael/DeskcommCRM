-- manifest: **Aparência da organização (template visual e ajustes).** Cria `fn_definir_aparencia_da_organizacao(p_org, p_aparencia)`, a única escritora de `organizations.settings.aparencia` — o template escolhido na tela Configurações › Aparência e os ajustes (fonte, arredondamento, densidade, intensidade dos efeitos, cor secundária). Confere papel `admin`, modo suporte e segundo fator pelo `auth.uid()`, valida a forma (só as seis chaves conhecidas, valores de lista fechada em minúsculas, cor como `#rrggbb`) e grava com `jsonb_set` atômico, sem tocar `settings.branding` nem nenhuma outra chave. `null` ou `{}` remove a chave e devolve a aparência de fábrica. Não cria tabela nem coluna; nenhuma linha existente muda. Revoga `public`/`anon`, concede a `authenticated`.

-- APARÊNCIA DA ORGANIZAÇÃO
--
-- Por que uma função, e não um UPDATE da aplicação: a única policy de escrita de
-- `organizations` é a de admin de plataforma, então o UPDATE pela sessão de um
-- admin de tenant casa ZERO linhas e devolve sucesso; e ler-mesclar-gravar o
-- `settings` inteiro pela aplicação disputaria com os outros escritores de
-- `settings` (marca, agenda, CRM). `jsonb_set` dentro da função mexe só na
-- chave `aparencia`, no mesmo UPDATE.
--
-- O que a função NÃO sabe, de propósito: a lista de templates e de fontes. Ela
-- vive no código (`lib/aparencia/catalogo.ts`, `lib/aparencia/fontes.ts`), e o
-- leitor (`aparenciaDeSettings`) trata id desconhecido como "aparência de
-- fábrica". Repetir a lista aqui obrigaria uma migration a cada template novo.
-- O banco garante a FORMA: chaves conhecidas, texto curto em minúsculas, hex.

create or replace function public.fn_definir_aparencia_da_organizacao(p_org uuid, p_aparencia jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_chave  text;
  v_valor  jsonb;
  v_antes  jsonb;
  v_depois jsonb;
begin
  if auth.uid() is null
     or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aparencia_da_organizacao_sem_permissao' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'aparencia_da_organizacao_mfa_required' using errcode = '42501';
  end if;

  if p_aparencia is not null and jsonb_typeof(p_aparencia) <> 'null' then
    if jsonb_typeof(p_aparencia) <> 'object' then
      raise exception 'aparencia_da_organizacao_forma_invalida' using errcode = '22023';
    end if;
    for v_chave, v_valor in select e.key, e.value from jsonb_each(p_aparencia) e loop
      if v_chave not in ('template', 'fonte', 'raio', 'densidade', 'efeitos', 'cor_secundaria') then
        raise exception 'aparencia_da_organizacao_chave_desconhecida: %', v_chave using errcode = '22023';
      end if;
      if jsonb_typeof(v_valor) = 'null' then
        continue;
      end if;
      if jsonb_typeof(v_valor) <> 'string' then
        raise exception 'aparencia_da_organizacao_valor_invalido: %', v_chave using errcode = '22023';
      end if;
      if v_chave = 'cor_secundaria' then
        if (v_valor #>> '{}') !~ '^#[0-9a-f]{6}$' then
          raise exception 'aparencia_da_organizacao_cor_invalida' using errcode = '22023';
        end if;
      elsif (v_valor #>> '{}') !~ '^[a-z][a-z0-9-]{0,31}$' then
        raise exception 'aparencia_da_organizacao_valor_invalido: %', v_chave using errcode = '22023';
      end if;
    end loop;
    v_depois := nullif(jsonb_strip_nulls(p_aparencia), '{}'::jsonb);
  end if;

  -- `for no key update`, e não `for update`: serializa dois admins salvando ao
  -- mesmo tempo sem barrar os INSERTs com FK para a organização.
  select o.settings -> 'aparencia' into v_antes
    from public.organizations o
   where o.id = p_org
     for no key update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  update public.organizations o
     set settings = case
       when v_depois is null then coalesce(o.settings, '{}'::jsonb) - 'aparencia'
       else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{aparencia}', v_depois, true)
     end
   where o.id = p_org;

  return jsonb_build_object('aparencia', v_depois, 'mudou', v_antes is distinct from v_depois);
end $$;

revoke execute on function public.fn_definir_aparencia_da_organizacao(uuid, jsonb) from public, anon;
grant  execute on function public.fn_definir_aparencia_da_organizacao(uuid, jsonb) to authenticated;
