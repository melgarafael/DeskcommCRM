-- manifest: **Ao juntar duas fichas, a que FICA não herda mais o nome da absorvida (#3721).** `fn_mesclar_contatos` fazia `name = coalesce(name, v_nome)` com o `name` dos perdedores, e `name` é o TÍTULO da ficha (`nomeDoContato`, lib/contacts/rotulo-do-contato.ts:105 — `name`, depois `display_name`, depois o número) e o que o `{{nome}}` das automações e das campanhas lê (lib/contacts/nome-da-agenda.ts:92-99). Medido na tela: A "Ana Cliente WhatsApp" (só `display_name`, veio da ingestão do WhatsApp) fica, B "Bruno Escritório Fixo" é absorvida, e o título de A vira "Bruno". Agora `name` não é herdado em caso nenhum — a identidade é de quem o operador escolheu para ficar — e o nome do perdedor vira histórico em `source_metadata.nomes_absorvidos` (`[{contato_id, name}]`, em `created_at, id`) e no jsonb de retorno da função, que a rota `/api/v1/contacts/merge` devolve na resposta (a auditoria `contact.merged` grava os ids, não o nome); o `name` original continua também na lápide. `display_name` (o rótulo do canal, não o nome digitado) segue herdado SÓ quando o vencedor já tem `name`: com `name` nulo o rótulo herdado viraria o título e o defeito voltaria pela outra porta. É a régua que a 0407 já aplicava a CPF e `consent` (:279-283) — campo que IDENTIFICA a pessoa não se herda. `social_identity`, `waha_lid`, `email`, `phone_number`, `birthdate`, `tags`, `custom_fields` e o telefone extra por absorvida (9043) ficam como estão; assinatura, `search_path`, `security definer` e grants INALTERADOS (`create or replace` preserva a ACL). Idempotente; espelho idêntico no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116). Prova em `tests/invariants/juntar-fichas-nao-herda-o-nome.test.ts`.
-- 9049 — ao juntar fichas, o nome do PERDEDOR não vira o título da que fica
-- (issue #3721).
--
-- ## O defeito
--
-- `fn_mesclar_contatos` herdava do perdedor tudo o que o vencedor não tinha, e
-- `name` estava nessa lista. `name` não é um campo qualquer: é o TÍTULO da
-- ficha (`nomeDoContato` em lib/contacts/rotulo-do-contato.ts:105 — `name`,
-- depois `display_name`, depois o número) e é o que o `{{nome}}` das automações
-- e das campanhas lê (lib/contacts/nome-da-agenda.ts:92-99). Medido pelo
-- mantenedor na tela do #3671: a ficha A "Ana Cliente WhatsApp" (só
-- `display_name`, chegou pela ingestão do WhatsApp) fica, a B "Bruno Escritório
-- Fixo" é absorvida — e o título de A passa a ser "Bruno".
--
-- ## A régua que já estava escrita no arquivo
--
-- O comentário da 0407 (:279-283) recusa herdar CPF e `consent`: CPF é um par
-- preso por check constraint, e `consent` é registro legal do que AQUELA pessoa
-- autorizou. A régua comum aos dois é uma só: **campo que IDENTIFICA a pessoa
-- não se herda**. `name` é o nome que alguém digitou para dizer quem é aquela
-- pessoa; movê-lo de uma ficha para outra troca a identidade do cadastro, e a
-- fusão não tem desfazer.
--
-- ## A decisão, e o custo de cada caminho
--
-- (1) `name` NÃO é herdado, em caso nenhum — o vencedor fica com o nome que
--     tinha, nulo inclusive. A fusão declara "estas duas fichas são a mesma
--     pessoa", mas QUAL identidade fica é escolha do operador, feita na tela
--     que ele acabou de ver ("Ana Cliente WhatsApp fica."). Herdar o nome do
--     perdedor desfaz essa escolha em silêncio, no único campo que a lista
--     mostra em negrito — e, como consequência, a próxima campanha cumprimenta
--     Ana pelo nome de Bruno.
--     CUSTO: quem escolhe a ficha do WhatsApp (sem `name`) para ficar não ganha
--     mais o nome digitado da outra; ela fica com o `display_name` que já
--     mostrava. Se aquele nome era o verdadeiro, alguém o digita na ficha —
--     uma decisão humana explícita em vez de uma herança que ninguém viu. E a
--     busca por nome não acha mais a ficha pelo nome que ficou só na absorvida:
--     o rastro está em `source_metadata.nomes_absorvidos` e na lápide.
-- (2) Herdar o `name` só quando a absorvida "fosse a principal" NÃO EXISTE:
--     `p_contato_principal` é ARGUMENTO da função, então a absorvida nunca é a
--     principal. Quem quiser que o nome do outro lado vença escolhe a outra
--     ficha para ficar — é o que a tela oferece, e é reversível pela escolha.
-- (3) `display_name` continua sendo herdado, mas SÓ quando o vencedor já tem
--     `name`. `display_name` é o RÓTULO do canal (webhook de WhatsApp,
--     importação de CSV), não o nome que alguém digitou: com `name` no lugar a
--     herança é invisível e segue valendo ("o que ele não tem, vem dos
--     perdedores"). Sem `name`, porém, o rótulo herdado SERIA o título
--     (`name ?? display_name`) e o defeito voltaria pela outra porta — por isso
--     a condição. CUSTO: uma ficha que não tinha nem `name` nem `display_name`
--     continua sem título e aparece pelo número (`rotuloDoContato`), que é o
--     que o operador viu ao escolhê-la.
--
-- ## O que NÃO muda
--
-- `social_identity`, `waha_lid`, `email`, `phone_number`, `birthdate`, `tags` e
-- `custom_fields` seguem herdados, com as mesmas guardas de unicidade; o
-- telefone principal de cada absorvida continua virando telefone extra da ficha
-- que fica (9043); CPF e `consent` continuam fora. Sem tabela, sem coluna, sem
-- índice, sem dado reescrito.
--
-- Idempotente: um `create or replace`. Espelho idêntico no apêndice do
-- `supabase/baseline.sql`, antes da VARREDURA anon (0116). Corpo copiado da
-- ÚLTIMA definição da cadeia (9043).

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
  v_nomes_absorvidos jsonb := '[]'::jsonb;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_social text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
  v_campos jsonb;
  v_sec record;
  v_canon text;
  v_lid_extra text;
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

  -- 4b · (9043) Os telefones extras das absorvidas que repetem o número ou o
  --     `lid` da ficha que fica saem ANTES do repontamento: o repetido não é
  --     registro perdido, é o mesmo número, e não pode cair no
  --     `unique_violation` do laço nem ser contado em `nao_repontado`. Os
  --     demais seguem para a ficha que fica pelo repontamento do catálogo.
  delete from public.contact_phones t
   where t.organization_id = p_organization_id
     and t.contact_id = any(p_contatos_secundarios)
     and (
       t.phone_number = public.fn_telefone_canonico(v_principal.phone_number)
       or (t.wa_lid is not null and t.wa_lid = v_principal.wa_lid)
     );

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
  -- (#3721) O `name` é a EXCEÇÃO da herança, e a mais forte de todas: não é um
  -- dado que falta, é a IDENTIDADE da ficha — o título na tela e o `{{nome}}`
  -- das automações. Herdá-lo do perdedor trocava o nome de quem o operador
  -- acabou de escolher para ficar, em silêncio e sem desfazer. Então ele não é
  -- herdado em caso nenhum; o que se guarda é o HISTÓRICO de quem foi absorvido
  -- com nome, para a ficha não perder o rastro.
  select coalesce(
           jsonb_agg(jsonb_build_object('contato_id', c.id, 'name', btrim(c.name))
                     order by c.created_at, c.id),
           '[]'::jsonb)
    into v_nomes_absorvidos
    from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and nullif(btrim(c.name), '') is not null;
  -- O `display_name` é o RÓTULO do canal, não o nome que alguém digitou — segue
  -- herdado, mas só quando o vencedor já tem `name`: sem ele, o rótulo herdado
  -- seria o título (`name ?? display_name`) e o defeito voltaria por aqui.
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
  -- (9043) Primeiro o `lid` da absorvida cujo telefone vira o principal: o
  -- número e o WhatsApp dele andam juntos.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by (v_principal.phone_number is null and c.phone_number is not distinct from v_telefone) desc,
            c.created_at, c.id limit 1;
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
  -- (9043) Pela forma canônica e olhando os extras: o número que já é extra de
  -- alguém (inclusive da ficha que fica) não pode virar principal — a regra
  -- "um número, uma ficha" recusaria e a fusão inteira cairia.
  if v_telefone is not null and (exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number is not null
       and public.fn_telefone_canonico(o.phone_number) = public.fn_telefone_canonico(v_telefone)
  ) or exists (
    select 1 from public.contact_phones t
     where t.organization_id = p_organization_id
       and t.phone_number = public.fn_telefone_canonico(v_telefone)
  )) then v_telefone := null; end if;
  if v_lid is not null and (exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) or exists (
    select 1 from public.contact_phones t
     where t.organization_id = p_organization_id and t.wa_lid = v_lid
  )) then v_lid := null; end if;
  if v_social is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.social_identity = v_social
  ) then v_social := null; end if;

  -- (9043) `custom_fields`: a chave que a ficha que fica não tem entra; em
  -- chave repetida vence a ficha que fica e, entre absorvidas, a primeira
  -- (por `created_at, id`, a ordem de todo o resto). Antes, o que estava na
  -- absorvida ficava só na lápide.
  select coalesce(jsonb_object_agg(s.chave, s.valor), '{}'::jsonb) into v_campos
    from (
      select distinct on (e.key) e.key as chave, e.value as valor
        from public.contacts c
        cross join lateral jsonb_each(
          case when jsonb_typeof(c.custom_fields) = 'object' then c.custom_fields else '{}'::jsonb end
        ) as e
       where c.organization_id = p_organization_id
         and c.id = any(p_contatos_secundarios)
       order by e.key, c.created_at, c.id
    ) as s;

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
  -- (#3721) `name` NÃO entra no SET: o título da ficha é de quem fica (passo 6).
  update public.contacts set
    display_name = coalesce(
      display_name,
      case when name is null then null else v_apelido end
    ),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    social_identity = coalesce(social_identity, v_social),
    tags = v_tags,
    custom_fields = v_campos || coalesce(custom_fields, '{}'::jsonb),
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
         )
      -- (#3721) O nome do perdedor vira HISTÓRICO da ficha. `{}` || x = x:
      -- fusão sem perdedor com nome não acrescenta chave nenhuma.
      || case when jsonb_array_length(v_nomes_absorvidos) > 0
              then jsonb_build_object(
                     'nomes_absorvidos',
                     coalesce(source_metadata->'nomes_absorvidos', '[]'::jsonb)
                       || v_nomes_absorvidos)
              else '{}'::jsonb end,
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 6b · (9043) O telefone principal de cada absorvida vira telefone extra da
  --     ficha que fica, com tipo, WhatsApp e o `lid` dela — sem isto, a próxima
  --     mensagem daquele número não acha ficha viva e abre uma terceira. Fica de
  --     fora o número que a ficha que fica já tem (principal ou extra) e o de
  --     uma terceira ficha viva (como o e-mail, não herda). O `lid` que já é de
  --     alguém vivo não vai junto.
  for v_sec in
    select c.phone_number, c.phone_type, c.phone_whatsapp,
           nullif(regexp_replace(coalesce(c.source_metadata->>'waha_lid', ''), '@.*$', ''), '') as lid
      from public.contacts c
     where c.organization_id = p_organization_id
       and c.id = any(p_contatos_secundarios)
       and c.phone_number is not null
     order by c.created_at, c.id
  loop
    v_canon := public.fn_telefone_canonico(v_sec.phone_number);
    continue when v_canon is null;
    continue when exists (
      select 1 from public.contacts o
       where o.organization_id = p_organization_id and o.is_merged_into is null
         and o.phone_number is not null
         and public.fn_telefone_canonico(o.phone_number) = v_canon
    ) or exists (
      select 1 from public.contact_phones t
       where t.organization_id = p_organization_id and t.phone_number = v_canon
    );
    v_lid_extra := v_sec.lid;
    if v_lid_extra is not null and (exists (
      select 1 from public.contacts o
       where o.organization_id = p_organization_id and o.is_merged_into is null
         and o.wa_lid = v_lid_extra
    ) or exists (
      select 1 from public.contact_phones t
       where t.organization_id = p_organization_id and t.wa_lid = v_lid_extra
    )) then
      v_lid_extra := null;
    end if;
    insert into public.contact_phones
      (organization_id, contact_id, phone_number, tipo, whatsapp, origem, wa_lid)
    values
      (p_organization_id, p_contato_principal, v_canon,
       coalesce(v_sec.phone_type, public.fn_tipo_do_telefone(v_canon)),
       coalesce(v_sec.phone_whatsapp, 'nao_sei'), 'fusao', v_lid_extra);
  end loop;

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
    'nomes_absorvidos', v_nomes_absorvidos,
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$;
