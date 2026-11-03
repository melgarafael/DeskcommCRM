-- manifest: O aviso à equipe pode sair pelo número oficial, dentro de um modelo aprovado: `config_aviso_de_caso.modelo_id` (FK composta com a organização para `meta_templates`, `on delete set null (modelo_id)`) e `fn_definir_aviso_de_caso` com `p_modelo uuid default null` (10 parâmetros; a de 9 sai), que recusa com `aviso_de_caso_modelo_invalido` o modelo de outra conexão. Sem modelo, nada muda.
--
-- 9094 — o aviso à equipe pelo número oficial, com modelo aprovado.
--
-- ─── O que não dava para fazer ──────────────────────────────────────────────
--
-- A tela "Aviso no WhatsApp" só aceitava conexão que manda texto livre a
-- qualquer hora. Uma organização cujo único número estável é o oficial nunca
-- conseguia avisar a equipe: o switch travava (`so_canal_oficial`), a ação
-- "Mensagem para a equipe" pulava com `canal_nao_aceita_texto_livre` e o aviso
-- de caso era condenado com `canal_nao_aceita_aviso_livre`. Fora da janela de
-- 24 h, o número oficial só fala por modelo aprovado — e é isso que passa a ser
-- possível escolher.
--
-- ─── Por que uma coluna na configuração, e não na regra ─────────────────────
--
-- O modelo é do NÚMERO que envia, como a conexão: a mesma escolha serve ao
-- aviso de caso, ao teste da tela e à ação "Mensagem para a equipe". Na regra,
-- cada automação teria de repetir a escolha, e a ação "Mensagem para a equipe"
-- não carrega destino nem conteúdo por decisão (#2642). Ele vale também no modo
-- `responsavel` da 9078: o destino muda, o número que envia não.
--
-- ─── Por que FK composta, com `on delete set null (modelo_id)` ──────────────
--
-- Composta com `organization_id`, como a do remetente do lembrete (0625): o
-- banco recusa o modelo de OUTRA organização mesmo numa escrita que não passe
-- pela função. A lista de colunas no `set null` é o que torna isso possível
-- aqui: `organization_id` é a chave primária desta tabela, e um `set null`
-- sem lista anularia também ela. Apagar o modelo do espelho zera só a coluna:
-- a configuração fica, a tela mostra o bloqueio e o envio recusa com o motivo.
--
-- Que o modelo é desta CONEXÃO é pergunta da função (a FK não sabe de conexão);
-- que está APROVADO e tem uma variável só é pergunta da rota e do envio
-- (`lib/escalacao/modelo-do-aviso.ts`), porque o status muda na plataforma sem
-- passar por aqui.
--
-- Idempotente, psql puro, sem BEGIN/COMMIT. Espelho no apêndice do
-- `baseline.sql`, ANTES da VARREDURA anon (recria uma função).

-- ---- a coluna e a FK composta ----
--
-- A chave (organization_id, id) em `meta_templates` é a MESMA que outra FK
-- composta para o espelho de modelos pode precisar, com o MESMO nome: o `if not
-- exists` deixa as duas entrarem em qualquer ordem sem duplicar o índice. O
-- `id` já é único, então ela não recusa linha nenhuma de quem já tem dados.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meta_templates_organization_id_id_key'
      and conrelid = 'public.meta_templates'::regclass
  ) then
    alter table public.meta_templates
      add constraint meta_templates_organization_id_id_key unique (organization_id, id);
  end if;
end $$;

alter table public.config_aviso_de_caso
  add column if not exists modelo_id uuid;

-- Auto-cura ANTES da constraint: uma linha que já aponte para modelo inexistente
-- ou de OUTRA organização faria o `update.sh` quebrar ao criar a FK. Ela perde o
-- modelo (volta ao texto livre, e a tela diz o que falta) e fica.
update public.config_aviso_de_caso c
   set modelo_id = null
 where c.modelo_id is not null
   and not exists (
         select 1 from public.meta_templates t
          where t.id = c.modelo_id
            and t.organization_id = c.organization_id);

-- Uma FK simples na mesma coluna, se existir, sai: a composta a substitui, e
-- as duas juntas só duplicariam a checagem.
alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_modelo_id_fkey;

do $$ begin
  alter table public.config_aviso_de_caso
    drop constraint if exists config_aviso_de_caso_modelo_org_fkey;
  alter table public.config_aviso_de_caso add constraint config_aviso_de_caso_modelo_org_fkey
    foreign key (organization_id, modelo_id)
    references public.meta_templates(organization_id, id)
    on delete set null (modelo_id) deferrable initially deferred;
end $$;

comment on column public.config_aviso_de_caso.modelo_id is
  'Modelo aprovado (meta_templates) que leva o aviso quando a conexão só manda modelo fora da janela de 24 h. Uma variável só, no corpo: o texto do aviso entra nela numa linha só. Nulo = texto livre (a conexão precisa aceitar). Gravado por fn_definir_aviso_de_caso (admin), lido pelo aviso de caso, pelo teste da tela e pela ação "Mensagem para a equipe". Migration 9094.';

-- ---- a porta de escrita ----
--
-- A função ganha o décimo parâmetro. `create or replace` com outra lista de
-- parâmetros cria OUTRA função: a de 9 sai logo abaixo, senão o PostgREST
-- teria duas e a chamada de 9 argumentos ficaria ambígua.
create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_resposta_whatsapp_habilitada boolean default false,
  p_destino_modo text default 'fixo',
  p_responsaveis jsonb default null,
  p_modelo uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes public.config_aviso_de_caso;
  v_arch timestamptz;
  v_digitos text;
  v_variantes text[];
  v_modo text;
  v_item jsonb;
  v_uid uuid;
  v_numero text;
  v_digitos_do_membro text;
  v_variantes_do_membro text[];
begin
  -- Papel + suporte, nesta ordem e na MESMA transação da escrita. `auth.uid()`
  -- nulo é o caminho do service role: quem escreve configuração é gente.
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_caso_forbidden' using errcode = '42501';
  end if;
  -- Quem NÃO tem fator cadastrado passa: a função já trata isso, e é coerente
  -- com a política de MFA opcional deste produto.
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_caso_mfa_required' using errcode = '42501';
  end if;
  if p_telefone is null or p_telefone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'aviso_de_caso_telefone_invalido' using errcode = '22023';
  end if;

  -- O modo é vocabulário FECHADO: um valor fora dos dois que o motor conhece
  -- deixaria a tela dizendo uma coisa e o envio fazendo outra.
  v_modo := coalesce(nullif(btrim(p_destino_modo), ''), 'fixo');
  if v_modo not in ('fixo', 'responsavel') then
    raise exception 'aviso_de_caso_destino_invalido' using errcode = '22023';
  end if;

  -- O canal é DA organização e não está arquivado. Sem isto a FK simples
  -- deixaria apontar para o canal de outro tenant — a FK composta do padrão
  -- 0228 não serve aqui porque o `on delete set null` anularia também
  -- `organization_id`, que é a chave primária desta tabela.
  if p_channel is not null then
    select archived_at into v_arch
      from public.channel_sessions
     where id = p_channel and organization_id = p_org;
    if not found or v_arch is not null then
      raise exception 'aviso_de_caso_canal_invalido' using errcode = '22023';
    end if;
  end if;

  -- O MODELO APROVADO é DESTA organização e DESTA conexão (migration 9094). A
  -- mesma regra de `lib/channels/linha-do-espelho.ts`: a linha gravada para a
  -- conexão, ou a linha sem conexão da conta oficial dela. A FK composta já
  -- recusa o modelo de outro tenant, mas não sabe de conexão: sem isto, o
  -- envio sairia com uma definição que este número não tem. Se ele está
  -- APROVADO e tem uma variável só é pergunta da rota
  -- (`lib/escalacao/modelo-do-aviso.ts`), e de novo do envio: o status muda
  -- na plataforma sem passar por aqui.
  if p_modelo is not null then
    if p_channel is null or not exists (
         select 1 from public.meta_templates t
          where t.id = p_modelo
            and t.organization_id = p_org
            and (t.channel_session_id = p_channel
                 or (t.channel_session_id is null and exists (
                       select 1 from public.channel_sessions s
                        where s.organization_id = p_org
                          and s.id = p_channel
                          and s.provider = 'meta_cloud'
                          and s.meta_waba_id = t.waba_id)))) then
      raise exception 'aviso_de_caso_modelo_invalido' using errcode = '22023';
    end if;
  end if;

  -- As duas grafias do nono dígito — a MESMA regra de
  -- `lib/channels/phone-variants.ts`. Comparar a string crua deixaria passar o
  -- número do suporte cadastrado com 9 e registrado sem.
  v_digitos := regexp_replace(p_telefone, '\D', '', 'g');
  v_variantes := array[v_digitos];
  if v_digitos like '55%' then
    if length(v_digitos) = 13
       and substring(v_digitos from 5 for 1) = '9'
       and substring(v_digitos from 6 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || substring(v_digitos from 6));
    elsif length(v_digitos) = 12
       and substring(v_digitos from 5 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || '9' || substring(v_digitos from 5));
    end if;
  end if;

  -- O NÚMERO DE AVISO NÃO PODE SER UM NÚMERO DA PRÓPRIA ORGANIZAÇÃO. É o laço
  -- robô-com-robô: a conexão de avisos manda para o número oficial, o agente
  -- dele responde, e as duas pontas se alimentam sem fim.
  -- A conexão ARQUIVADA fica FORA da conta. Ela não envia nem recebe, então o
  -- laço não acontece por ela — e contá-la bloqueia o número PARA SEMPRE, porque
  -- a conexão que já teve agente publicado não pode ser apagada (as versões a
  -- seguram) e o número nunca mais poderia receber aviso.
  if exists (
       select 1 from public.channel_sessions s
        where s.organization_id = p_org
          and s.archived_at is null
          and s.phone_number is not null
          and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes)) then
    raise exception 'aviso_de_caso_numero_da_propria_org' using errcode = '22023';
  end if;

  -- O número de aviso vira INTERNO: tudo o que chegar dele deixa de virar
  -- contato, conversa, lead e despacho do agente. Se ele já é um CLIENTE desta
  -- organização, as mensagens dessa pessoa param de chegar ao CRM — e isso não
  -- pode acontecer por engano. A tela pergunta e reenvia com `p_confirma_contato`.
  if not coalesce(p_confirma_contato, false) and exists (
       select 1 from public.contacts c
        where c.organization_id = p_org
          and c.phone_number is not null
          and regexp_replace(c.phone_number, '\D', '', 'g') = any (v_variantes)) then
    raise exception 'aviso_de_caso_numero_de_cliente' using errcode = '22023';
  end if;

  -- ─── O WhatsApp de cada pessoa da equipe (#3803) ─────────────────────────
  --
  -- Só membro ATIVO da organização é gravado: número de quem saiu da equipe não
  -- recebe aviso, e aceitá-lo aqui daria um destino que nunca é resolvido.
  -- Vazio (`''` ou nulo) É uma informação — significa "esta pessoa não tem
  -- número" —, e por isso grava nulo em vez de recusar.
  if p_responsaveis is not null then
    if jsonb_typeof(p_responsaveis) <> 'array' then
      raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_responsaveis) loop
      v_uid := nullif(btrim(coalesce(v_item ->> 'user_id', '')), '')::uuid;
      if v_uid is null then
        raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
      end if;
      v_numero := nullif(btrim(coalesce(v_item ->> 'whatsapp', '')), '');
      if v_numero is not null then
        -- O mesmo "dígitos com `+` na frente" que a tela normaliza
        -- (`normalizarTelefoneDeAviso`): quem manda `31 99888-7777` recebe o
        -- número guardado na forma canônica em vez de um 22023 que não explica.
        v_numero := '+' || regexp_replace(v_numero, '\D', '', 'g');
        if v_numero !~ '^\+[1-9][0-9]{7,14}$' then
          raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
        end if;
        -- No modo `responsavel` este número É o destino do aviso. Um número
        -- conectado desta organização abriria por aqui o mesmo laço
        -- robô-com-robô que a guarda do número da empresa fecha: mesma conta
        -- (conexão ativa, as duas grafias do nono dígito) e mesmo código.
        v_digitos_do_membro := regexp_replace(v_numero, '\D', '', 'g');
        v_variantes_do_membro := array[v_digitos_do_membro];
        if v_digitos_do_membro like '55%' then
          if length(v_digitos_do_membro) = 13
             and substring(v_digitos_do_membro from 5 for 1) = '9'
             and substring(v_digitos_do_membro from 6 for 1) between '6' and '9' then
            v_variantes_do_membro := v_variantes_do_membro
              || (substring(v_digitos_do_membro from 1 for 4) || substring(v_digitos_do_membro from 6));
          elsif length(v_digitos_do_membro) = 12
             and substring(v_digitos_do_membro from 5 for 1) between '6' and '9' then
            v_variantes_do_membro := v_variantes_do_membro
              || (substring(v_digitos_do_membro from 1 for 4) || '9' || substring(v_digitos_do_membro from 5));
          end if;
        end if;
        if exists (
             select 1 from public.channel_sessions s
              where s.organization_id = p_org
                and s.archived_at is null
                and s.phone_number is not null
                and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes_do_membro)) then
          raise exception 'aviso_de_caso_numero_da_propria_org' using errcode = '22023';
        end if;
      end if;
      update public.user_organizations uo
         set whatsapp_e164 = v_numero
       where uo.organization_id = p_org
         and uo.user_id = v_uid
         and uo.revoked_at is null;
    end loop;
  end if;

  select * into v_antes from public.config_aviso_de_caso where organization_id = p_org;

  insert into public.config_aviso_de_caso
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, resposta_whatsapp_habilitada, destino_modo, modelo_id, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), coalesce(p_resposta_whatsapp_habilitada, false), v_modo, p_modelo, auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
        resposta_whatsapp_habilitada = excluded.resposta_whatsapp_habilitada,
        destino_modo       = excluded.destino_modo,
        -- Gravar o que veio, inclusive o `null`: é o que impede o modelo de
        -- uma conexão antiga de ficar para trás depois da troca de número.
        modelo_id          = excluded.modelo_id,
        atualizado_por     = auth.uid(),
        -- Trocou o número, o JID resolvido do anterior não vale mais — e é o
        -- JID que o corte da ingestão usa para reconhecer quem está em modo
        -- privacidade. Mantê-lo faria o corte continuar valendo para o número
        -- ANTIGO, que pode voltar a ser um cliente.
        destino_jid        = case
                               when excluded.telefone_destino is distinct from config_aviso_de_caso.telefone_destino
                               then null
                               else config_aviso_de_caso.destino_jid
                             end,
        updated_at         = now();

  return jsonb_build_object(
    'trocou_numero', (v_antes.telefone_destino is distinct from p_telefone),
    'antes_ligado',  coalesce(v_antes.ligado, false),
    'destino_modo',  v_modo
  );
end;
$$;
revoke execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb,uuid) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb,uuid) to authenticated;
-- As sobrecargas antigas saem: a de 9 (9078) e, por garantia, as de 6 e 7, que
-- vivas ao lado desta deixariam ambígua a chamada com menos argumentos.
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb);
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean);
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean);
