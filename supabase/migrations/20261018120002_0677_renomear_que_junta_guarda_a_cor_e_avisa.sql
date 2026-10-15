-- manifest: **Renomear para um nome que já existe JUNTA as duas etiquetas — e agora a junção não perde a cor nem responde como renome simples (issue #2801).** Medido em Postgres na triagem do #2784: com o vocabulário `[{tag: "b"}, {tag: "a", cor: "#ab4aba"}]` ("b" sem cor, ANTES de "a"), `renomear a -> b` devolvia `[{tag: "b"}]` — a cor que o operador escolheu sumia, e a operação respondia `alterou: true` idêntica a um renome simples. O dedupe do ramo renomear/juntar em `fn_vocabulario_de_tags_operar` era `order by lower(x.chave), x.ord`: ficava a primeira entrada pela POSIÇÃO, com ou sem metadado. (A) O desempate passa a ser PELO METADADO ANTES DA ORDEM — `((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc, x.ord`, o MESMO desempate da função de leitura (`fn_vocabulario_de_tags`) e do ramo `definir_cor`, que já preferia metadado. Regra dos DOIS sentidos, declarada: metadado decide contra AUSÊNCIA de metadado; quando as duas entradas já têm metadado (duas cores), o empate volta a ser a ordem no vocabulário, isto é, fica quem já ocupava a posição de destino — cor contra cor tem de perder uma, e preservar a identidade (nome + posição + cor) de quem já estava lá é a escolha. (B) O retorno ganha `juntou boolean`: o banco é quem sabe se o destino já existia, e sem o marcador a tela não tinha o que dizer — hoje ela avisa, no toast e antes de confirmar. `create or replace` na MESMA assinatura de cinco argumentos; `revoke`/`grant` reafirmados nas DUAS origens de EXECUTE. Sem tabela, coluna ou dado novo. O corpo parte da 0673 (issue #2895, "excluir etiqueta preserva as outras"), que redefine a MESMA função: a anulação por chave da 0673 fica intacta, e esta migration vem DEPOIS dela na cadeia. Apêndice no `baseline.sql` depois do bloco da 0673 e ANTES da VARREDURA anon (0116). Gates: `tests/invariants/tags-juntar-guarda-a-cor.test.ts` (RED/GREEN em Postgres real: a cor sobrevive, os DOIS sentidos, `juntou` no retorno e `definir_cor` intacto), `tests/unit/tags-juntar-guarda-a-cor.test.ts` (o desempate está no TEXTO da última definição, nos dois artefatos) e a suíte de vocabulário existente.

-- 0677: renomear que junta guarda a cor e avisa (issue #2801).
--
-- Detalhe completo no `-- manifest:` acima; o bloco é o MESMO, letra a letra, no
-- apêndice de `supabase/baseline.sql` — é ele que o `update.sh` reaplica a cada
-- atualização, inclusive em quem nunca vai rodar migrations.
--
-- As DUAS mudanças estão no ramo renomear/juntar de
-- `fn_vocabulario_de_tags_operar`, e as duas são correção de comportamento, não
-- de forma: a assinatura, os privilégios e as ações continuam os mesmos da 0336.
--
-- ⚠️ O corpo parte da 0673 (excluir uma etiqueta não apaga as outras), letra a
-- letra, e só acrescenta o delta desta: o desempate pelo metadado e `juntou`. A
-- anulação por chave da 0673 (`when v_remover and lower(...) = lower(v_tag)`)
-- fica como está. Quem redefinir esta função depois parte DESTA versão.

-- ---- renomear que junta: a cor sobrevive e a operação avisa (migration 0677, issue #2801) ----
-- O dedupe do ramo renomear/juntar era `order by lower(x.chave), x.ord`: a
-- primeira entrada pela posição ficava, COM OU SEM cor/descrição. Renomear "a"
-- (com cor) para "b" (que já existia, sem cor) perdia a cor — e a operação
-- respondia `alterou: true` igual a um renome simples, sem dizer que juntou.
--
-- (A) O desempate passa a ser pelo METADADO ANTES da ordem, o mesmo que a
--     função de leitura e o ramo `definir_cor` já usam. Metadado decide contra
--     AUSÊNCIA de metadado; duas entradas com metadado empatam e o desempate
--     volta a ser a ordem — fica quem já estava na posição de destino.
-- (B) O retorno ganha `juntou`. É o banco que sabe se o destino já existia: a
--     tela só tem a lista que ela mesma leu, e o caso interessante é o que já
--     vinha como duas linhas. Alcance declarado: `juntou` mede o VOCABULÁRIO
--     CURADO; `juntar` um nome que só existia em uso não colapsa entrada nenhuma
--     ali (`fn_tags_normalizar` é outro desenho), e o marcador fica `false`.

create or replace function public.fn_vocabulario_de_tags_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text,
  p_cor text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tag     text := btrim(coalesce(p_tag, ''));
  v_destino text := btrim(coalesce(p_destino, ''));
  -- A cor entra normalizada (minúscula, sem espaço). A rota valida com Zod antes;
  -- esta linha defende o caminho que NÃO passa por ela — RPC direta, psql, um
  -- cliente futuro. Sem isso, `#FFF` gravaria e a comparação por igualdade da
  -- tela (que compara o que o servidor devolveu) passaria a mentir.
  v_cor     text := lower(btrim(coalesce(p_cor, '')));
  v_remover boolean;
  v_so_cor  boolean;
  v_contatos integer := 0;
  v_leads integer := 0;
  v_conversas integer := 0;
  v_regras integer := 0;
  v_id uuid;
  v_ids uuid[];
  v_settings jsonb;
  v_antes jsonb;
  v_depois jsonb;
  v_definido boolean := false;
  -- (e0) 'duas entradas do vocabulário viraram uma' — issue #2801.
  v_juntou boolean := false;
begin
  -- Portão de papel ANTES de qualquer escrita. Definer com p_org vindo da rota:
  -- é esta linha que separa o tenant de quem chama.
  if p_org is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_acao is null or p_acao not in ('renomear', 'juntar', 'excluir', 'definir_cor') then
    raise exception using errcode = '22023', message = 'acao_invalida';
  end if;
  if v_tag = '' then
    raise exception using errcode = '22023', message = 'tag_obrigatoria';
  end if;
  v_remover := (p_acao = 'excluir');
  v_so_cor  := (p_acao = 'definir_cor');
  if not v_remover and not v_so_cor and v_destino = '' then
    raise exception using errcode = '22023', message = 'destino_obrigatorio';
  end if;
  -- `v_cor` vazio é pedido legítimo ("sem cor"): limpa. O que não passa é cor
  -- malformada — gravar `#12` e devolver `#12` para a tela pintar deixaria o
  -- chip sem cor sem ninguém saber por quê.
  if v_so_cor and v_cor <> '' and v_cor !~ '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'cor_invalida';
  end if;

  -- ── POR QUE NÃO SAI EVENTO DAQUI ──────────────────────────────────────────
  --
  -- Os laços abaixo CONTAM as linhas alteradas e não emitem nada em `event_log`.
  -- A primeira versão emitia `contact.tags_changed` / `lead.tags_changed` /
  -- `conversation.tags_changed` POR LINHA, e nenhum desses tipos tem consumidor:
  -- `lib/event-log/register-handlers.ts` registra 13 handlers e nenhum os
  -- declara; o motor de automação ouve `lead.tag_added`/`contact.tag_added`, que
  -- é outro tipo (e disparar automação num renomear em lote seria pior que não
  -- disparar). Evento sem consumidor é o anti-pattern 3 do CLAUDE.md, e aqui
  -- custava milhares de linhas dentro de UMA transação, num log que nada drena e
  -- nada expurga.
  --
  -- Quem registra a operação é o AUDIT LOG, na borda: `tag_vocabulary.changed`
  -- em `app/api/v1/tags/vocabulario/route.ts`, com os contadores que este corpo
  -- devolve. E a tela aberta se atualiza pelo Realtime das próprias tabelas.

  -- ── (z) A COR SAI ANTES DOS LAÇOS, E NÃO É OTIMIZAÇÃO ─────────────────────
  --
  -- Cor é atributo do VOCABULÁRIO, não das linhas: `contacts.tags`,
  -- `crm_leads.tags` e `conversations.tags` continuam `text[]` de nomes, porque
  -- automação, webhook (`lead.tag_added`) e MCP (`*.tags_changed`) falam em
  -- string há versões (contrato da fatia S4). Então a ação `definir_cor` não tem
  -- o que reescrever em contatos, leads nem conversas — e os laços abaixo, se
  -- rodassem, custariam uma varredura das três tabelas para devolver zero.
  --
  -- O bloco de `canonical_conversation_tags` (mais abaixo) é pior que inútil
  -- aqui: ele troca o nome da semente por `v_destino` e descarta o que sobra
  -- vazio — com `destino` nulo nesta ação, a semente seria APAGADA. Daí o
  -- `return` cedo: nesta ação, só o vocabulário curado muda.
  if v_so_cor then
    select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o where o.id = p_org;
    if v_settings is null then
      v_settings := '{}'::jsonb;
    end if;

    -- (a) tolera `settings.tags` torto (escalar/objeto): a leitura já tolera com
    -- `jsonb_typeof`, e sem esta guarda o `jsonb_array_elements` levantava
    -- `cannot extract elements from a scalar` e derrubava a tela inteira numa
    -- organização com o dado malformado. Lista que não é lista é lista vazia.
    v_antes := case
      when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
      else '[]'::jsonb
    end;
    v_depois := coalesce(
      (
        select jsonb_agg(entrada.valor order by entrada.ord)
        from (
          -- Uma entrada por chave canônica, agora acrescentando a cor na que
          -- casar. A entrada que era string vira objeto — a mesma forma que o
          -- rename já grava (mais abaixo, `jsonb_build_object('tag', …)`) — e
          -- `descricao` que já existia é PRESERVADA: esta ação fala de cor.
          --
          -- ⚠️ O desempate é o MESMO da função de leitura
          -- (`fn_vocabulario_de_tags`, `order by … (cor is not null or descricao
          -- is not null) desc`), e de propósito: onde a lista curada já tiver a
          -- mesma etiqueta duas vezes (uma como string, outra como objeto com
          -- cor), quem sobrevive é a entrada que carrega o metadado. Ordenar só
          -- por `ord` apagaria a cor na primeira vez que a ação rodasse sobre um
          -- vocabulário nesse estado, e a tela mostraria "sem cor" logo depois de
          -- alguém ter escolhido uma.
          select distinct on (lower(x.chave)) x.valor, x.ord
          from (
            select btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) as chave,
                   case
                     when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then case
                            when nullif(v_cor, '') is null
                            then (case when jsonb_typeof(e.valor) = 'string'
                                       then jsonb_build_object('tag', e.valor #>> '{}')
                                       else e.valor end) - 'cor'
                            else jsonb_set(
                                   case when jsonb_typeof(e.valor) = 'string'
                                        then jsonb_build_object('tag', e.valor #>> '{}')
                                        else e.valor end,
                                   '{cor}', to_jsonb(v_cor))
                          end
                     else case when jsonb_typeof(e.valor) = 'string'
                               then jsonb_build_object('tag', e.valor #>> '{}')
                               else e.valor end
                   end as valor,
                   e.ord
            from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
            where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
          ) x
          where x.valor is not null
          order by lower(x.chave),
                   ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                   x.ord
        ) as entrada
      ),
      '[]'::jsonb
    );

    -- A etiqueta que ainda não tinha entrada no vocabulário curado — semente, ou
    -- nome que só existe em uso (`no_vocabulario = false` na leitura) — GANHA
    -- uma. É deliberado: dar cor é curar. Sem isto, a tela ofereceria cor para
    -- uma etiqueta que continuaria marcada como "em uso, fora do vocabulário", e
    -- a leitura devolveria a cor de uma linha que não está na lista curada.
    if nullif(v_cor, '') is not null and not exists (
      select 1 from jsonb_array_elements(v_depois) as e(valor)
      where lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
    ) then
      v_depois := v_depois || jsonb_build_array(jsonb_build_object('tag', v_tag, 'cor', v_cor));
    end if;

    if v_depois <> v_antes then
      v_settings := jsonb_set(v_settings, '{tags}', v_depois);
      update public.organizations o
         set settings = v_settings,
             updated_at = now()
       where o.id = p_org;
      v_definido := true;
    end if;

    return jsonb_build_object(
      'acao', p_acao,
      'tag', v_tag,
      'destino', null,
      'cor', nullif(v_cor, ''),
      'contatos', 0,
      'leads', 0,
      'conversas', 0,
      'regras', 0,
      'alterou', v_definido
    );
  end if;

  -- (a) contatos
  for v_id in
    with alvo as (
      select c.id, public.fn_tags_normalizar(c.tags, v_tag, v_destino, v_remover) as novas
      from public.contacts c
      where c.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(c.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.contacts c
         set tags = a.novas
        from alvo a
       where c.id = a.id
         and c.tags is distinct from a.novas
      returning c.id
    )
    select id from mudou
  loop
    v_contatos := v_contatos + 1;
  end loop;

  -- (b) leads
  for v_id in
    with alvo as (
      select l.id, public.fn_tags_normalizar(l.tags, v_tag, v_destino, v_remover) as novas
      from public.crm_leads l
      where l.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(l.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.crm_leads l
         set tags = a.novas
        from alvo a
       where l.id = a.id
         and l.tags is distinct from a.novas
      returning l.id
    )
    select id from mudou
  loop
    v_leads := v_leads + 1;
  end loop;

  -- (c) conversas
  for v_id in
    with alvo as (
      select v.id, public.fn_tags_normalizar(v.tags, v_tag, v_destino, v_remover) as novas
      from public.conversations v
      where v.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(v.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.conversations v
         set tags = a.novas
        from alvo a
       where v.id = a.id
         and v.tags is distinct from a.novas
      returning v.id
    )
    select id from mudou
  loop
    v_conversas := v_conversas + 1;
  end loop;

  -- (d) as regras dos agentes — o ponto da issue.
  --
  -- `excluir` NÃO apaga a regra: quem exclui a etiqueta é avisado de quantas
  -- regras a escrevem (o número volta no jsonb e a tela pede confirmação), mas
  -- apagar `add_tag` de um agente em produção é decisão de outra tela. Aqui a
  -- lista da regra só é reescrita quando o nome muda ou quando ele sai.
  select coalesce(o.settings, '{}'::jsonb) into v_settings
  from public.organizations o where o.id = p_org;

  if v_settings is null then
    v_settings := '{}'::jsonb;
  end if;

  if not v_remover then
    with alvo as (
      select r.id,
             jsonb_agg(
               case
                 when a.valor ->> 'type' = 'add_tag'
                  and jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                 then jsonb_set(
                        a.valor,
                        '{config,tags}',
                        to_jsonb(public.fn_tags_normalizar(
                          array(select jsonb_array_elements_text(a.valor -> 'config' -> 'tags')),
                          v_tag, v_destino, false
                        ))
                      )
                 else a.valor
               end
               order by a.ord
             ) as novas
      from public.automation_rules r
      cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
        with ordinality as a(valor, ord)
      where r.organization_id = p_org
      -- ⚠️ `group by r.id` E SÓ. Agrupar também pelo TIPO da ação devolvia uma
      -- linha por (regra, tipo), cada uma com `novas` = só o subconjunto daquele
      -- tipo; o `update ... from alvo` casava as duas linhas, o Postgres usava
      -- UMA arbitrária, e `is distinct from` é sempre verdadeiro num subconjunto
      -- — então a regra com ações de dois tipos era TRUNCADA a um tipo só, em
      -- toda organização, mesmo que ela nunca tenha citado a etiqueta renomeada.
      -- Medido num Postgres real: regra com `add_tag` + `assign_owner` ficava com
      -- uma ação, e a tela dizia "atualizada em 1 regra(s) de agente".
      group by r.id
    ), mudou as (
      update public.automation_rules r
         set actions = alvo.novas,
             updated_at = now()
        from alvo
       where r.id = alvo.id
         and r.actions is distinct from alvo.novas
      returning r.id
    )
    select count(*) into v_regras from mudou;
  else
    -- Exclusão: conta as regras que ainda escrevem a etiqueta, sem tocar nelas.
    select count(distinct r.id) into v_regras
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as a(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
           then a.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as e(valor)
    where r.organization_id = p_org
      and a.valor ->> 'type' = 'add_tag'
      and lower(btrim(e.valor #>> '{}')) = lower(v_tag);
  end if;

  -- (e) o vocabulário da organização, nos dois lugares onde ele mora.
  -- Mesma guarda do ramo de renomear: `settings.tags` malformado não pode
  -- derrubar a cor (a leitura tolera; a escrita agora também).
  v_antes := case
    when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
    else '[]'::jsonb
  end;

  -- ── (e0) O AVISO DE JUNÇÃO — renomear NÃO é renome simples quando o nome
  -- já existe (issue #2801) ────────────────────────────────────────────────
  --
  -- Renomear para um nome que JÁ ESTÁ no vocabulário junta as duas entradas
  -- numa só, e a operação respondia `alterou: true` idêntico a um renome
  -- simples: a tela dizia "Etiqueta atualizada" enquanto duas etiquetas
  -- viravam uma. O marcador é medido AQUI, no vocabulário curado, e não na
  -- tela — a tela só tem a lista que ela mesma acabou de ler, e o caso
  -- justamente interessante é o que já vinha como DUAS linhas.
  --
  -- O alcance é declarado: `juntou` diz "duas ENTRADAS do vocabulário curado
  -- colapsaram". `juntar` um nome que só existia em uso (fora do vocabulário)
  -- não colapsa entrada nenhuma ali, e o marcador fica `false` — o que
  -- normalizou os nomes nesse caso foi `fn_tags_normalizar`, outro desenho.
  if not v_remover then
    select exists (
      select 1
      from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
      where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
      group by lower(
                case when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                     else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                end
              )
      having count(*) > 1
    ) into v_juntou;
  end if;

  v_depois := coalesce(
    (
      select jsonb_agg(entrada.valor order by entrada.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição (mesma razão de
        -- `fn_tags_normalizar`): juntar duas entradas de chaves diferentes num
        -- nome só deixava as duas no vocabulário, agora com o mesmo `tag`.
        --
        -- ⚠️ `cor` e `descricao` da entrada sobrevivem ao rename: o `jsonb_set`
        -- mexe só em `{tag}`. Renomear não é perder a cor que alguém escolheu.
        select distinct on (lower(x.chave)) x.valor, x.ord
        from (
          select case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                   else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                 end as chave,
                 case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then jsonb_set(
                            case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                                 else e.valor end,
                            '{tag}', to_jsonb(v_destino))
                   else case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                             else e.valor end
                 end as valor,
                 e.ord
          from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
          where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
        ) x
        where x.valor is not null and coalesce(x.chave, '') <> ''
        -- ⚠️ O DESEMPATE É PELO METADADO, ANTES DA ORDEM (issue #2801).
        --
        -- Com `order by lower(x.chave), x.ord` a primeira entrada pela posição
        -- ficava, COM OU SEM cor/descrição: renomear "a" (que tinha cor) para
        -- "b" (que existia antes, sem cor) PERDIA a cor que o operador havia
        -- escolhido — a entrada vazia de metadado vinha primeiro na lista.
        -- Este é o MESMO desempate da função de leitura
        -- (`fn_vocabulario_de_tags`) e do ramo `definir_cor`: onde a lista tem
        -- a mesma etiqueta duas vezes, sobrevive a que carrega metadado.
        --
        -- Quando as DUAS já têm metadado, o metadado não decide mais nada e o
        -- desempate volta a ser a ORDEM: fica a que já ocupava a posição no
        -- vocabulário — isto é, o destino. Cor contra cor tem de perder uma, e
        -- a regra escolhida preserva a identidade (nome + posição + cor) de
        -- quem já estava lá, em vez de deixar a posição da lista decidir
        -- qualquer coisa depois de virar empate técnico.
        order by lower(x.chave),
                 ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                 x.ord
      ) as entrada
      where entrada.valor is not null
    ),
    '[]'::jsonb
  );
  if v_depois <> v_antes then
    v_settings := jsonb_set(v_settings, '{tags}', v_depois);
    v_definido := true;
  end if;

  v_antes := coalesce(v_settings -> 'canonical_conversation_tags', '[]'::jsonb);
  v_depois := coalesce(
    (
      select jsonb_agg(semente.valor order by semente.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição, como acima.
        select distinct on (lower(y.valor)) y.valor, y.ord
        from (
          select case
                   when v_remover and lower(btrim(s.valor #>> '{}')) = lower(v_tag) then null
                   when lower(btrim(s.valor #>> '{}')) = lower(v_tag) then v_destino
                   else btrim(s.valor #>> '{}')
                 end as valor,
                 s.ord
          from jsonb_array_elements(v_antes) with ordinality as s(valor, ord)
          where btrim(s.valor #>> '{}') <> ''
        ) y
        where coalesce(y.valor, '') <> ''
        order by lower(y.valor), y.ord
      ) as semente
      where semente.valor is not null
    ),
    '[]'::jsonb
  );
  if v_depois <> v_antes then
    v_settings := jsonb_set(v_settings, '{canonical_conversation_tags}', v_depois);
    v_definido := true;
  end if;

  if v_definido then
    update public.organizations o
       set settings = v_settings,
           updated_at = now()
     where o.id = p_org;
  end if;

  return jsonb_build_object(
    'acao', p_acao,
    'tag', v_tag,
    'destino', nullif(v_destino, ''),
    'cor', null,
    'contatos', v_contatos,
    'leads', v_leads,
    'conversas', v_conversas,
    'regras', v_regras,
    -- `juntou` é o AVISO de que esta operação juntou duas etiquetas do
    -- vocabulário numa só (issue #2801). Sem ele a resposta era indistinguível
    -- de um renome simples, e a tela não tinha o que dizer. `false` no renome
    -- que não juntou, no excluir e em `juntar` cujo destino não estava no
    -- vocabulário curado (ver o bloco (e0)).
    'juntou', v_juntou,
    'alterou', (v_contatos + v_leads + v_conversas + v_regras > 0 or v_definido)
  );
end;
$$;

-- A de escrita é definer e volátil, e segue declarada em AUTHENTICATED_PERMITIDO
-- no gate tests/invariants/hardening-definer-varredura.test.ts. Assinatura de
-- CINCO argumentos desde a 0336: sem as duas linhas abaixo, o EXECUTE que o
-- Postgres dá a PUBLIC na criação ficaria de pé — alcançável pela anon key.
revoke execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) to authenticated, service_role;
