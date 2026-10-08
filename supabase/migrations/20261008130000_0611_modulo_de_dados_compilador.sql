-- manifest: O banco COMPILA o schema que um módulo declara (onda 1 da ADR-0005): `fn_modulo_dados_compilar` lê um artefato já admitido em `extension_artifacts` e cria as tabelas dos objetos declarados, server-only e com FK COMPOSTA por organização, porque a checagem de FK não passa por RLS; `fn_extensions_finish_install` passa a aceitar o perfil `data` e chama o compilador na MESMA transação do recibo.
-- 0611 — O compilador de módulo de dados: quem escreve o SQL é o BANCO, lendo o artefato admitido.
--
-- Onda 1 da ADR-0005. Um módulo de terceiro declara objetos e campos num artefato JSON; esta função
-- lê esse artefato — a linha de `extension_artifacts`, que é imutável, validada na admissão e
-- auditada — e cria as tabelas correspondentes.
--
-- POR QUE O PARÂMETRO É UM ID, E NÃO DDL. A ADR-0002 D4 sustenta a provisionadora `security definer`
-- em dois pés: ela não tem seletor vindo de quem chama, e o efeito é fixo e conhecido. Passar SQL (ou
-- nome de tabela) por parâmetro derrubaria os dois. Aqui o parâmetro é o id de uma linha JÁ admitida:
-- quem chama não escolhe o efeito, escolhe qual artefato auditado aplicar. Todo identificador que vai
-- para o DDL é construído pela função e escapado com `format(%I)`; nada do JSON entra como texto cru,
-- e o TIPO vem de um vocabulário fechado — tipo desconhecido levanta, nunca vira texto solto.
--
-- O QUE ESTA MIGRATION AINDA NÃO FAZ. Esta lista já afirmou o inverso do que o PR entrega — ela
-- dizia que a referência composta, a rota e a tela ficavam para depois, e as três entraram. Foi um
-- cético que pegou, lendo a prosa contra o diff. O que falta de verdade, hoje:
--
--   * truncamento de nome em 63 bytes (o limite do identificador no Postgres);
--   * idempotência da RECOMPILAÇÃO (reinstalar a mesma versão com objeto novo);
--   * registro em `modulos_instalados` (o módulo de dados não aparece em `/admin/modulos`);
--   * liga/desliga POR ORGANIZAÇÃO — ver a nota no fim deste cabeçalho.
--
-- Cada um entra com o seu próprio teste vermelho antes.
--
-- ── Por que o corte é por INSTALAÇÃO, e não por organização (onda 1) ────────────────────────────
--
-- `organization_extensions.enabled` é o liga/desliga por empresa das extensões DECLARATIVAS, e ele
-- não serve ao perfil `data` como está: o CHECK de `configuration` exige as chaves `density` e
-- `show_description`, que são da apresentação de um guia, e o manifesto de um módulo de dados
-- declara `configuration: {}`. Além disso a instalação NÃO cria linha nessa tabela — só
-- `fn_extensions_configure` cria. Travar o painel em `enabled` esconderia o painel em TODA
-- instalação, porque a linha nunca existe. Então o corte segue o da ADR-0002 D3 ("o corte é por
-- instalação"). A consequência disso é resolvida na TELA, e não aqui: o painel só aparece onde há
-- dado da própria empresa — painel sem nenhuma ficha não é desenhado
-- (`components/modulos/FichasDoModulo.tsx`, com o caso que o prova em `FichasDoModulo.test.tsx`).

-- ── O alvo da referência precisa de chave composta ──────────────────────────────────────────────
--
-- Uma FK para `contacts(id)` sozinha NÃO isola tenant: a checagem de chave estrangeira não passa por
-- RLS, então o id de um contato de outra organização seria aceito e o módulo viraria ponte entre
-- tenants. A FK composta `(organization_id, <ref>_id) → contacts(organization_id, id)` fecha isso, e
-- exige um índice único sobre essas duas colunas em `contacts`.
--
-- O índice é criado AQUI, no caminho do schema, e NÃO sob demanda na instalação de um módulo:
-- `create unique index` sem `concurrently` toma lock de escrita, e numa VPS com a ingestão de
-- WhatsApp no ar isso pararia o atendimento. O kit já aplica o baseline em janela de atualização.
--
-- A guarda é a mesma do laço da 0378 (alvos `crm_pipelines`, `crm_stages`, `ai_agents`): cria só se
-- NÃO houver índice único sobre exatamente essas duas colunas, senão toda instalação ganharia um
-- segundo índice idêntico, pago em cada escrita de contato.
do $$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_class t on t.oid = i.indrelid
     where t.relname = 'contacts'
       and t.relnamespace = 'public'::regnamespace
       and i.indisunique
       and i.indnatts = 2
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(i.indkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
       ) = array['organization_id', 'id']
  ) then
    create unique index uq_contacts_org_id on public.contacts (organization_id, id);
  end if;
end $$;

create or replace function public.fn_modulo_dados_compilar(p_artifact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_manifest jsonb;
  v_objeto jsonb;
  v_campo jsonb;
  v_ref jsonb;
  v_tabela text;
  v_nome text;
  v_tipo text;
  v_nulo text;
  v_alvo text;
  v_colunas text;
  v_criadas text[] := '{}';
begin
  select manifest into v_manifest from public.extension_artifacts where id = p_artifact_id;
  if v_manifest is null then
    raise exception using errcode = 'P0001', message = 'modulo_artefato_nao_encontrado';
  end if;

  for v_objeto in select value from jsonb_array_elements(v_manifest -> 'data' -> 'objetos') loop
    -- O nome é CONSTRUÍDO aqui: prefixo fixo, publicador, módulo e objeto, com `-` virando `_`.
    -- O pacote não escolhe nome de tabela; ele escolhe um slug que entra num molde.
    v_tabela := 'm_'
      || replace(v_manifest ->> 'publisher', '-', '_') || '_'
      || replace(v_manifest ->> 'name', '-', '_') || '_'
      || (v_objeto ->> 'slug');

    v_colunas := '';
    for v_campo in select value from jsonb_array_elements(v_objeto -> 'campos') loop
      v_nome := v_campo ->> 'slug';
      v_tipo := v_campo ->> 'tipo';
      v_nulo := case when coalesce((v_campo ->> 'obrigatorio')::boolean, false) then ' not null' else '' end;

      if v_tipo = 'texto' then
        v_colunas := v_colunas || format(', %I text%s', v_nome, v_nulo);
      elsif v_tipo = 'texto_longo' then
        v_colunas := v_colunas || format(', %I text%s', v_nome, v_nulo);
      elsif v_tipo = 'inteiro' then
        v_colunas := v_colunas || format(', %I integer%s', v_nome, v_nulo);
      elsif v_tipo = 'booleano' then
        v_colunas := v_colunas || format(', %I boolean%s', v_nome, v_nulo);
      elsif v_tipo = 'data' then
        v_colunas := v_colunas || format(', %I date%s', v_nome, v_nulo);
      elsif v_tipo = 'data_hora' then
        v_colunas := v_colunas || format(', %I timestamptz%s', v_nome, v_nulo);
      elsif v_tipo = 'dinheiro' then
        -- A régua de dinheiro do projeto: inteiro de centavos + moeda ISO-4217. `numeric` solto para
        -- dinheiro é o erro que a doutrina já proíbe em toda tabela do núcleo.
        v_colunas := v_colunas || format(
          ', %I bigint%s, %I text not null default ''BRL'' check (char_length(%I) = 3)',
          v_nome || '_cents', v_nulo, v_nome || '_moeda', v_nome || '_moeda');
      else
        -- Vocabulário FECHADO. Um tipo que o host não conhece não vira coluna de palpite: recusa.
        raise exception using errcode = 'P0001', message = 'modulo_tipo_de_campo_desconhecido';
      end if;
    end loop;

    -- As referências a entidades do núcleo. A entidade vem de uma ALLOWLIST: o pacote não aponta
    -- para tabela arbitrária, e entidade que o host não conhece recusa em vez de virar palpite.
    for v_ref in select value from jsonb_array_elements(coalesce(v_objeto -> 'refs', '[]'::jsonb)) loop
      v_nome := (v_ref ->> 'slug') || '_id';
      v_nulo := case when coalesce((v_ref ->> 'obrigatorio')::boolean, false) then ' not null' else '' end;

      if v_ref ->> 'entidade' = 'contato' then
        v_alvo := 'contacts';
      else
        raise exception using errcode = 'P0001', message = 'modulo_entidade_desconhecida';
      end if;

      -- Onda 1a: só `cascata`. `anula` precisa de `on delete set null (coluna)` — anular a FK
      -- composta inteira tentaria anular `organization_id`, que é NOT NULL, e isso explodiria só na
      -- hora de apagar um contato, em produção. Entra com o seu próprio teste.
      if coalesce(v_ref ->> 'ao_apagar', 'cascata') <> 'cascata' then
        raise exception using errcode = 'P0001', message = 'modulo_acao_ao_apagar_nao_suportada';
      end if;

      v_colunas := v_colunas
        || format(', %I uuid%s', v_nome, v_nulo)
        || format(
             ', foreign key (organization_id, %I) references public.%I (organization_id, id) on delete cascade',
             v_nome, v_alvo);
    end loop;

    execute format(
      'create table if not exists public.%I (
         id uuid primary key default gen_random_uuid(),
         organization_id uuid not null references public.organizations(id) on delete cascade%s,
         created_at timestamptz not null default now(),
         updated_at timestamptz not null default now()
       )', v_tabela, v_colunas);

    -- ⚠️ A ORDEM IMPORTA, e é a da ADR-0005 D3. Toda tabela criada em `public` depois do baseline
    -- nasce com GRANT ALL para `anon` e `authenticated` (o `ALTER DEFAULT PRIVILEGES` do baseline).
    -- A revogação vem ANTES de proteger: a tabela de módulo é server-only, e toda mutação tem de
    -- passar pela rota auditada do host em vez do PostgREST.
    execute format('revoke all on public.%I from anon, authenticated', v_tabela);

    v_criadas := v_criadas || v_tabela;
  end loop;

  -- As proteções que toda tabela de organização precisa ter, na MESMA transação (ADR-0002 D5):
  -- RLS ligada, isolamento por organização e as travas da sessão de suporte.
  perform public.fn_proteger_modulo_provisionado();

  -- ⚠️ O POSTGREST PRECISA SER AVISADO, e a falta disto era defeito de PRODUÇÃO — achado pelo e2e,
  -- não por leitura: a tabela nascia no banco e a rota de leitura do host (que fala por PostgREST)
  -- respondia `Could not find the table '…' in the schema cache` até o cache recarregar sozinho.
  -- Instalar um módulo e não conseguir ler o que ele guarda é instalar um módulo quebrado.
  --
  -- É o mesmo aviso que `fn_modulo_instalar` já dá no caminho de módulo oficial (ADR-0002).
  perform pg_notify('pgrst', 'reload schema');
  -- ⚠️ O RELOAD É ASSÍNCRONO, e isso é limitação conhecida desta onda, não detalhe: o PostgREST
  -- recarrega quando RECEBE o aviso, fora desta transação. Existe portanto uma janela de alguns
  -- segundos, logo depois de instalar, em que a tabela já existe no banco e a API ainda responde
  -- `Could not find the table … in the schema cache` — medido no e2e, que precisou esperar por ela.
  --
  -- O que isso significa para quem usa: o painel do módulo na ficha do contato pode aparecer com a
  -- mensagem de "não foi possível carregar" por alguns segundos depois da instalação, e carregar
  -- normalmente ao recarregar a página. A ficha do núcleo não é afetada (nn.1).
  --
  -- O que NÃO foi feito, e fica declarado: a tela não distingue "ainda preparando" de "falhou". Um
  -- estado próprio para a janela é trabalho da onda seguinte, e exige saber quando o reload terminou
  -- — o `pg_notify` não dá retorno.

  return jsonb_build_object('tabelas', to_jsonb(v_criadas));
end $f$;

-- Função nova em `public` nasce exposta por DUAS origens, e as duas são revogadas: o grant a PUBLIC
-- que o Postgres dá a qualquer função, e o grant a `anon` do `ALTER DEFAULT PRIVILEGES` do baseline.
revoke execute on function public.fn_modulo_dados_compilar(uuid) from public, anon;
revoke execute on function public.fn_modulo_dados_compilar(uuid) from authenticated;
grant execute on function public.fn_modulo_dados_compilar(uuid) to service_role;


-- ── A PORTA: o perfil `data` instala pelo caminho das extensões ─────────────────────────────────
--
-- A instalação de um módulo de dados NÃO ganha rota nova. Ela usa a das extensões, que já traz
-- catálogo admitido, download com guarda de SSRF, autoridade de administrador da instalação (escopo
-- `full`, fora de sessão de suporte, com verificação em duas etapas quando a política exige), recibo
-- durável idempotente, precondição por revisão e tela em `/admin/extensoes`. O que muda é o EFEITO da
-- conclusão: quando o perfil é `data`, as tabelas declaradas nascem na MESMA transação do recibo.
--
-- Mesma transação é a decisão, não detalhe: um recibo `completed` com as tabelas faltando deixaria a
-- tela anunciando um módulo que não guarda nada, e a repetição idempotente não reaplicaria.
--
-- Duas mudanças de vocabulário, as duas no mesmo espírito de lista fechada:
--
-- 1. A concessão `dados.proprios`. O pacote de dados não pede porta de navegação, e a validação exigia
--    de 1 a 7 permissões — array vazio era recusado. Em vez de dar ao módulo uma porta que ele não
--    usa, ele declara a concessão que de fato exerce, e ela aparece na tela de consentimento como as
--    outras. O teto sobe para 8 porque o vocabulário tem 8 valores.
-- 2. Os objetos declarados moram na chave `data`, que o manifesto JÁ reservava para o modo de dados
--    (`{"mode":"none"}` no perfil declarativo). Nenhuma 14ª chave: `data` passa a aceitar
--    `{"mode":"declarado", "objetos":[…]}`, e o perfil declarativo continua exigindo exatamente
--    `{"mode":"none"}` — quem não declara dados não ganha nenhuma folga nova.

create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 8
    and not exists (
      select 1 from jsonb_array_elements(p_permissions) e
      where jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in (
              'navigation.tasks', 'navigation.inbox', 'navigation.kanban',
              'navigation.contacts', 'navigation.agenda', 'navigation.radar',
              'theme.apply', 'dados.proprios')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
$$;

create or replace function public.fn_extensions_finish_install(p_actor uuid, p_operation uuid, p_manifest jsonb, p_sha256 text, p_byte_length integer, p_document text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.extension_operations; v_catalog public.extension_catalogs;
  v_artifact public.extension_artifacts; v_install public.extension_installations; v_current public.extension_artifacts;
  v_previous public.extension_artifacts; v_document_json jsonb; v_active integer := 0;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation for update;
  if not found then raise exception using errcode='P0001',message='extension_operation_not_found'; end if;
  if v_op.kind not in ('install','update') or v_op.actor_id is distinct from p_actor then
    raise exception using errcode='P0001',message='extension_operation_conflict';
  end if;
  -- Sem autoridade após cancel/fail. Resposta perdida de completed segue verificando payload.
  if v_op.status in ('cancelled','failed') then return to_jsonb(v_op) || jsonb_build_object('applied_now', false); end if;
  if p_document is null or octet_length(p_document) not between 1 and 65536
    or octet_length(p_document) is distinct from p_byte_length
    or encode(sha256(convert_to(p_document,'UTF8')),'hex') is distinct from p_sha256 then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  begin
    v_document_json := p_document::jsonb;
  exception when invalid_text_representation or untranslatable_character or program_limit_exceeded then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end;
  if v_document_json is distinct from p_manifest then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  if p_sha256 is distinct from v_op.entry->>'sha256' or p_byte_length is distinct from (v_op.entry->>'byte_length')::integer
    or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
    or not (p_manifest ?& array['format_version','profile','publisher','name','version','license','host_api','permissions','dependencies','data','display','configuration','contributions'])
    or p_manifest - array['format_version','profile','publisher','name','version','license','host_api','permissions','dependencies','data','display','configuration','contributions'] <> '{}'::jsonb
    or exists (select 1 from jsonb_each(p_manifest) e where e.value='null'::jsonb)
    or p_manifest->'format_version' is distinct from '1'::jsonb -- 0611: dois perfis. `declarative` segue igual; `data` declara objetos na chave `data`.
    or p_manifest->>'profile' not in ('declarative','data')
    or jsonb_typeof(p_manifest->'configuration') is distinct from 'object'
    or jsonb_typeof(p_manifest->'contributions') is distinct from 'object'
    or p_manifest->>'publisher' is distinct from v_op.publisher or p_manifest->>'name' is distinct from v_op.name
    or p_manifest->>'version' is distinct from v_op.version
    or p_manifest->'dependencies' <> '[]'::jsonb
    or (p_manifest->>'profile' = 'declarative' and p_manifest->'data' <> '{"mode":"none"}'::jsonb)
    or (p_manifest->>'profile' = 'data' and (
         p_manifest->'data'->>'mode' is distinct from 'declarado'
         or jsonb_typeof(p_manifest->'data'->'objetos') is distinct from 'array'
         or jsonb_array_length(p_manifest->'data'->'objetos') < 1))
    -- 0511: projeta os dois lados sobre as chaves que a ENTRADA do catálogo anuncia. Comparar os
    -- complementos fazia todo campo de vitrine da 0282 (publisher_label, homepage, repository,
    -- tags, published_at) divergir, e nenhuma entrada do catálogo oficial instalava.
    or exists (
      select 1 from unnest(array['publisher','name','version','license','host_api','display','permissions']) k
      where p_manifest->k is distinct from v_op.entry->k
    ) then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  if v_op.status='completed' then
    -- Compara com o artefato que ESTA conclusão publicou, não com o ponteiro de agora: um
    -- "desfazer" posterior não pode fazer a repetição acusar pacote adulterado.
    select * into v_artifact from public.extension_artifacts
      where id=coalesce(v_op.result->>'to_artifact_id', v_op.result->'installation'->>'artifact_id')::uuid;
    if not found or v_artifact.manifest is distinct from p_manifest or v_artifact.document is distinct from p_document then
      raise exception using errcode='P0001',message='extension_artifact_mismatch';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode='P0001',message='extension_core_update_in_progress';
  end if;
  select * into v_catalog from public.extension_catalogs where id=v_op.catalog_id;
  if v_catalog.revision is distinct from v_op.admission_revision or v_catalog.digest is distinct from v_op.admission_digest then
    raise exception using errcode='P0001',message='extension_catalog_stale';
  end if;
  select * into v_install from public.extension_installations
    where catalog_id=v_op.catalog_id and publisher=v_op.publisher and name=v_op.name for update;
  -- Defesa estrutural: a linha tem de estar na revisão que a preparação viu.
  if v_install.revision is distinct from (v_op.result->>'from_revision')::integer
    or (v_op.kind='update' and v_install.removed_at is not null)
    or (v_op.kind='install' and v_install.id is not null and v_install.removed_at is null) then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  if v_install.id is not null then
    select * into v_current from public.extension_artifacts where id=v_install.artifact_id;
    -- A recusa que a spec v1 prometeu para "quando o contrato admitir outra permissão".
    -- Sem ela, 1.0 -> 1.1 acrescentaria uma porta sem ninguém na organização rever a lista
    -- que a tela existe para mostrar: o furo entra pela porta lateral da própria propriedade
    -- que a lista de permissões garante. Mudar o conjunto de portas é outra extensão.
    if v_op.kind='update' and v_current.id is not null
      and v_current.manifest->'permissions' is distinct from p_manifest->'permissions' then
      raise exception using errcode='P0001',message='extension_permissions_changed';
    end if;
    select * into v_previous from public.extension_artifacts where id=v_install.previous_artifact_id;
    if (v_install.version = v_op.version and v_current.sha256 <> p_sha256)
      or (v_previous.id is not null and v_previous.manifest->>'version' = v_op.version and v_previous.sha256 <> p_sha256) then
      raise exception using errcode='P0001',message='extension_version_conflict';
    end if;
  end if;
  select * into v_artifact from public.extension_artifacts where sha256=p_sha256;
  if found then
    if v_artifact.manifest is distinct from p_manifest or v_artifact.document is distinct from p_document or v_artifact.byte_length <> p_byte_length then
      raise exception using errcode='P0001',message='extension_artifact_mismatch';
    end if;
  else
    insert into public.extension_artifacts(sha256,byte_length,manifest,document) values(p_sha256,p_byte_length,p_manifest,p_document) returning * into v_artifact;
  end if;
  if v_install.id is null then
    insert into public.extension_installations(catalog_id,artifact_id,publisher,name,version,installed_by)
      values(v_op.catalog_id,v_artifact.id,v_op.publisher,v_op.name,v_op.version,p_actor) returning * into v_install;
  elsif v_op.kind='install' then
    -- Reinstalação de uma linha removida: os vínculos NÃO voltam ativos; cada organização decide.
    update public.extension_installations set artifact_id=v_artifact.id, version=v_op.version, previous_artifact_id=null,
      removed_at=null, removed_by=null, installed_by=p_actor, installed_at=now(), revision=revision+1
      where id=v_install.id returning * into v_install;
  else
    update public.extension_installations set previous_artifact_id=artifact_id, artifact_id=v_artifact.id,
      version=v_op.version, revision=revision+1 where id=v_install.id returning * into v_install;
    select count(*)::integer into v_active from public.organization_extensions where installation_id=v_install.id and enabled;
  end if;
  -- 0611 — O EFEITO do perfil `data`, na MESMA transação do recibo.
  if p_manifest->>'profile' = 'data' then
    perform public.fn_modulo_dados_compilar(v_artifact.id);
  end if;
  update public.extension_operations set status='completed',installation_id=v_install.id,
    result=coalesce(v_op.result,'{}'::jsonb) || jsonb_build_object('installation',to_jsonb(v_install),
      'to_artifact_id',v_artifact.id,'to_version',v_op.version,'organizations_active',v_active),
    updated_at=now() where id=p_operation returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nome text;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_social text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui — quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- A TRAVA DA REGRA "CLIENTES PELA AGENDA" (migration 0262), ANTES DE TODA
  -- OUTRA. O passo 5 reponta `calendar_appointments.contact_id`, e o trigger
  -- desse repontamento pede `pg_advisory_xact_lock_shared(org, 262)` — só que
  -- a esta altura a fusão já segura os contatos (passos 2 e 3).
  -- `fn_definir_cliente_pela_agenda` pega a mesma trava EXCLUSIVA e depois
  -- trava contato por contato. Medido com duas sessões, sem esta linha: a fusão
  -- morria em `deadlock detected` e a rota devolvia 500. Aqui a ordem fica a
  -- mesma das duas funções — a organização primeiro, os contatos depois. Duas
  -- fusões, ou uma fusão e uma marcação, pegam a versão compartilhada e não se
  -- esperam.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_organization_id::text, 262));

  -- Mesmo mutex dos atendimentos, ANTES de qualquer row lock.
  for v_service_contact in select distinct id from unnest(array[p_contato_principal]||p_contatos_secundarios) ids(id) order by id loop
    perform public.fn_service_lock(p_organization_id,v_service_contact);
  end loop;
  perform 1 from public.conversations where organization_id=p_organization_id
    and contact_id=any(array[p_contato_principal]||p_contatos_secundarios) order by id for no key update;

  -- Conversa colidente NÃO aborta a fusão. Duas conversas no mesmo
  -- `channel_session_id` é exatamente COMO a duplicata de WhatsApp nasce (dois
  -- cadastros, dois números, o mesmo número de atendimento), então recusar aqui
  -- fecharia o caminho dominante do recurso — medido: o caso ordinário do
  -- `tests/e2e/juntar-contatos-duplicados.spec.ts` virava 409.
  -- Quem trata a colisão é o passo 5: `uniq_conversations_1to1_per_contact_session`
  -- levanta unique_violation, o repontamento cai para linha a linha, a conversa
  -- que não coube FICA na lápide e sai contada em `nao_repontado` — que a rota
  -- devolve e a tela anuncia ("N registro(s) continuaram no cadastro antigo").
  -- Mensagem não se perde: `messages.contact_id` não tem índice único por
  -- contato e passa inteira para o vencedor.

  -- 2 · O principal existe, é desta org, está vivo — e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      -- 0611: a POSIÇÃO da coluna que referencia `contacts.id`. FK COMPOSTA ficava fora do
      -- repontamento, e a ficha do módulo continuava apontando para o contato que SAIU da fusão.
      -- `left join lateral`, não subquery escalar no `ON`: a escalar zerava o laço inteiro.
      left join lateral (
        select k.ord
          from pg_catalog.unnest(co.confkey) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute fa
            on fa.attrelid = co.confrelid and fa.attnum = k.attnum
         where fa.attname = 'id'
         limit 1
      ) pos on true
      join pg_catalog.pg_attribute a
        on a.attrelid = co.conrelid
       and a.attnum = co.conkey[coalesce(pos.ord, 1)]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã — continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  select c.name into v_nome from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.name is not null
   order by c.created_at, c.id limit 1;
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão — `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by c.created_at, c.id limit 1;
  -- A identidade social é a MESMA razão do `waha_lid`, pelo lado de quem fala
  -- por rede social: com o #1444 `upsertSocialContact` filtra
  -- `is_merged_into is null`, então sem herdar a identidade a próxima DM daquela
  -- pessoa não acha ficha viva com esta identidade e abre uma nova — refazendo a
  -- duplicata que a fusão acabou de desfazer (issue #1455). O índice
  -- `contacts_org_social_identity_unique` é parcial em `is_merged_into is null`,
  -- então o único conflito possível é com um TERCEIRO contato vivo.
  select c.social_identity into v_social from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.social_identity is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo — e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  if v_telefone is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number = v_telefone
  ) then v_telefone := null; end if;
  if v_lid is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) then v_lid := null; end if;
  if v_social is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.social_identity = v_social
  ) then v_social := null; end if;

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação — mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  update public.contacts set
    name = coalesce(name, v_nome),
    display_name = coalesce(display_name, v_apelido),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    social_identity = coalesce(social_identity, v_social),
    tags = v_tags,
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         ),
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL — contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$;

revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from public, anon;
revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from authenticated;
grant execute on function public.fn_extensions_permissoes_validas(jsonb) to service_role;

revoke execute on function public.fn_extensions_finish_install(uuid, uuid, jsonb, text, integer, text) from public, anon;
revoke execute on function public.fn_extensions_finish_install(uuid, uuid, jsonb, text, integer, text) from authenticated;
grant execute on function public.fn_extensions_finish_install(uuid, uuid, jsonb, text, integer, text) to service_role;

-- O par ORIGINAL de `fn_mesclar_contatos`: ela é chamada pelo USUÁRIO LOGADO e consta como exceção
-- declarada em `hardening-definer-varredura`. O rodapé de função nova revogaria `authenticated` e
-- quebraria a junção de contatos para todo mundo — já aconteceu nesta frente.
revoke execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) to authenticated, service_role;
