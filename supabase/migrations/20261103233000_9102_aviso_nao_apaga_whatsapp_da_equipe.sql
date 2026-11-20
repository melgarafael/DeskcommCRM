-- manifest: o WhatsApp da equipe só é apagado quando a tela AFIRMA que não há número (`whatsapp: null`); membro que o corpo não menciona (chave ausente) é preservado, porque era isso que zerava `user_organizations.whatsapp_e164` de quem nunca pediu (#3935).
--
-- 9102 — "a tela não mostrou" deixa de ser "a pessoa apagou".
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- Em Casos › Avisos › "Avisar no WhatsApp", quando NÃO existe configuração
-- salva, o rascunho da tela não carregava os `whatsapp_e164` da equipe
-- (`AvisoNoWhatsApp.tsx`: `rascunhoDoEstado` devolvia `whatsapps: {}` no ramo
-- `!estado.config`) e o envio mandava a lista COMPLETA com `whatsapp: null` para
-- todo mundo — a lista sai de `estado.equipe`, que sempre esteve carregada. O
-- laço abaixo lia `v_item ->> 'whatsapp'`, que devolve SQL NULL tanto para
-- "não existe a chave" quanto para "a chave vale null", e gravava
-- `whatsapp_e164 = null` nos dois casos. Sequência real: configurar o aviso,
-- remover a configuração (`DELETE`), abrir a tela de novo e salvar — a equipe
-- inteira perde o número e ninguém é avisado.
--
-- ─── A decisão: o contrato ganha a distinção que faltava ────────────────────
--
-- · `whatsapp: null` no elemento = AFIRMAÇÃO de vazio → grava nulo (apaga). É a
--   forma de a pessoa limpar um número que ela viu na tela.
-- · chave `whatsapp` AUSENTE = a tela não falou deste membro → não toca. É o
--   que permite à tela salvar sem apagar número que ela não exibiu.
-- · `p_responsaveis` nulo = o corpo nem trouxe a equipe → não toca (como antes).
-- · lista VAZIA = nenhum membro mencionado → não toca. De propósito NÃO é
--   "apaga todos": a leitura da equipe é falha ABERTA em
--   `lib/escalacao/tela-do-aviso.ts` (quando a leitura falha, a tela recebe a
--   equipe vazia e `equipe_indisponivel`), e uma lista vazia que apagasse
--   transformaria um erro de leitura em perda de dado de toda a equipe.
--
-- A tela muda junto (mesma fatia): o rascunho sem configuração passa a partir
-- dos números gravados, e o corpo só manda `whatsapp` de quem foi exibido.
-- Nenhum dos dois lados basta sozinho — tela corrigida com contrato antigo
-- continua apagando no dia em que a leitura da equipe falhar.
--
-- ─── O que NÃO muda ─────────────────────────────────────────────────────────
--
-- · assinatura (10 parâmetros), grants e `security definer`: `create or replace`,
--   sem sobrecarga nova e sem `drop function`;
-- · todas as guardas — papel, suporte, MFA, E.164 do destino, canal, modelo,
--   número da própria organização, número de cliente e a exceção do membro da
--   equipe (#3900) — na mesma ordem;
-- · o formato canônico do número que entra ("dígitos com `+" na frente") e a
--   recusa de número conectado da própria organização.
--
-- Idempotente, psql puro, sem BEGIN/COMMIT. Espelho no apêndice do
-- `baseline.sql`, ANTES da VARREDURA anon (recria uma função).

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
  v_destino_e_de_membro boolean;
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

  -- ─── O NÚMERO DE AVISO QUE É DE UM MEMBRO DA EQUIPE (#3900) ──────────────
  --
  -- Em `responsavel` o destino é o WhatsApp PESSOAL de quem atende, e essa
  -- pessoa pode ser cliente da própria empresa (agência em que a equipe viaja
  -- pela agência). O número dela não vira INTERNO: o aviso sai e o que chega
  -- dele continua virando contato, conversa e atendimento — é a regra de
  -- `lib/escalacao/numero-interno-de-aviso.ts`, que lê `whatsapp_e164` para
  -- saber disto. Perguntar "as mensagens dele vão parar de chegar?" seria
  -- perguntar sobre uma consequência que NÃO acontece neste modo, então a
  -- pergunta não é feita — e a resposta volta para a rota, que a registra.
  --
  -- Membro ATIVO nos dois lugares em que o número pode estar: já gravado
  -- (`whatsapp_e164`) ou chegando AGORA em `p_responsaveis` — na primeira
  -- gravação a coluna ainda está nula, porque esta guarda roda antes do laço
  -- que a escreve. Quem saiu da equipe (`revoked_at`) não conta: o número dele
  -- não recebe aviso nenhum.
  --
  -- Fora de `responsavel` a pergunta continua sendo feita, sem exceção: em
  -- `fixo` o destino é o número da empresa, o número VIRA interno, e calar
  -- essa confirmação é o que a tela existe para evitar.
  v_destino_e_de_membro := false;
  if v_modo = 'responsavel' then
    select exists (
      select 1 from public.user_organizations uo
       where uo.organization_id = p_org
         and uo.revoked_at is null
         and uo.whatsapp_e164 is not null
         and regexp_replace(uo.whatsapp_e164, '\D', '', 'g') = any (v_variantes)
    ) into v_destino_e_de_membro;

    if not v_destino_e_de_membro and jsonb_typeof(p_responsaveis) = 'array' then
      select exists (
        select 1
          from jsonb_array_elements(p_responsaveis) as e
          join public.user_organizations uo
            on uo.organization_id = p_org
           and uo.revoked_at is null
           -- `::text` e não `::uuid`: um `user_id` torto no corpo tem de cair na
           -- recusa de formato do laço abaixo (`aviso_de_caso_whatsapp_invalido`),
           -- não virar erro de cast cru no meio da guarda.
           and uo.user_id::text = btrim(coalesce(e ->> 'user_id', ''))
         where nullif(btrim(coalesce(e ->> 'whatsapp', '')), '') is not null
           and regexp_replace(e ->> 'whatsapp', '\D', '', 'g') = any (v_variantes)
      ) into v_destino_e_de_membro;
    end if;
  end if;

  -- O número de aviso vira INTERNO: tudo o que chegar dele deixa de virar
  -- contato, conversa, lead e despacho do agente. Se ele já é um CLIENTE desta
  -- organização, as mensagens dessa pessoa param de chegar ao CRM — e isso não
  -- pode acontecer por engano. A tela pergunta e reenvia com `p_confirma_contato`.
  -- A exceção é o membro da equipe do #3900, e só em `responsavel`.
  if not v_destino_e_de_membro
     and not coalesce(p_confirma_contato, false)
     and exists (
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
  --
  -- ─── `null` e chave AUSENTE são coisas diferentes (#3935) ───────────────
  --
  -- `whatsapp: null` é uma AFIRMAÇÃO — "esta pessoa não tem número" —, e grava
  -- nulo: é assim que a tela apaga de propósito o número de quem pediu.
  --
  -- A chave ausente é a AUSÊNCIA de afirmação: a tela não exibiu esta pessoa,
  -- então não sabe o que há gravado, e o que ela não viu não pode virar `null`
  -- no banco. Era exatamente este o defeito: o rascunho sem configuração não
  -- carregava os números da equipe, mandava `null` para todos, e a equipe
  -- inteira perdia o WhatsApp num clique em Salvar. Chave ausente = NÃO MEXE.
  --
  -- `Vazio ('')` continua sendo afirmação de vazio, como antes.
  if p_responsaveis is not null then
    if jsonb_typeof(p_responsaveis) <> 'array' then
      raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_responsaveis) loop
      -- Elemento que não é objeto não TEM opinião sobre número nenhum: aceitá-lo
      -- em silêncio faria a tela acreditar que falou de alguém.
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
      end if;
      v_uid := nullif(btrim(coalesce(v_item ->> 'user_id', '')), '')::uuid;
      if v_uid is null then
        raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
      end if;
      -- A CHAVE, não o valor: ausente = "a tela não falou deste número" e o
      -- laço pula SEM tocar na coluna. `?` só é verdadeiro para chave presente,
      -- inclusive quando o valor dela é `null` — que segue gravando nulo.
      if not (v_item ? 'whatsapp') then
        continue;
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
    'destino_modo',  v_modo,
    -- QUAL regra autorizou um destino que já é cliente (#3900). A rota registra
    -- isto na auditoria: sem esta resposta, "membro da equipe" e "confirmação
    -- explícita" ficariam indistinguíveis no `api_audit_log`, que é append-only.
    'destino_e_de_membro', v_destino_e_de_membro
  );
end;
$$;
revoke execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb,uuid) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb,uuid) to authenticated;
