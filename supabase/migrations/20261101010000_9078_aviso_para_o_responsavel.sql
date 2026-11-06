-- manifest: o aviso de caso e o de proposta passam a aceitar o RESPONSÁVEL como destino, resolvido no envio (conversa → negócio aberto → carteira → número da empresa), com o WhatsApp de cada membro em `user_organizations.whatsapp_e164`; a configuração antiga fica intacta, porque `destino_modo` nasce `fixo` (#3803).
--
-- 9078 — o aviso vai para QUEM vai atender (#3803).
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- `config_aviso_de_caso` guarda UM número por organização, e é para ele que vão
-- o aviso de caso (`ai.case_opened`) e o de proposta (`proposal.ready_for_review`).
-- Numa agência com carteira por vendedor, quem precisa agir é o responsável pela
-- conversa, e o dono da empresa vira repassador manual justamente no caso em que
-- o cliente pediu uma pessoa.
--
-- ─── A decisão, e por que ela NÃO é uma coluna de número ────────────────────
--
-- `destino_modo` diz COMO escolher, não para onde mandar:
--
--   `fixo`        (default) `telefone_destino`, como sempre.
--   `responsavel` a cadeia conversa → negócio aberto → carteira → número da
--                 empresa, resolvida no momento do envio.
--
-- `telefone_destino` continua `not null` com CHECK E.164 e continua sendo o
-- ÚLTIMO elo da cadeia. Não há backfill: a coluna nova nasce com `fixo` e toda
-- instalação que já tinha número continua com o número — ninguém é migrado para
-- o modo novo sem alguém escolher na tela.
--
-- ─── Onde mora o WhatsApp do membro ─────────────────────────────────────────
--
-- Medido antes de escrever: o produto não tinha telefone de membro em lugar
-- nenhum (`contacts` é o do cliente, `channel_sessions` é a linha da empresa,
-- `people` é a ficha de CRM B2B e o perfil do usuário guarda nome/avatar/fuso/
-- idioma). O número que o aviso precisa é o celular PESSOAL de quem atende, por
-- organização — então ele entra em `user_organizations.whatsapp_e164`, a linha do
-- vínculo, que é a que a RLS já protege e a que a instalação já usa para saber
-- quem é membro. Nulo é o estado de quem não cadastrou, e é o caso que faz o elo
-- cair para o próximo.
--
-- ─── A porta de escrita continua sendo uma só ──────────────────────────────
--
-- `fn_definir_aviso_de_caso` ganha dois argumentos com default:
--
--   p_destino_modo    `fixo`/`responsavel`; qualquer outra coisa é 22023.
--   p_responsaveis    `[{user_id, whatsapp}]` — grava o WhatsApp de cada membro
--                     ativo da organização na MESMA transação da configuração.
--
-- Juntar as duas escritas numa função é o que mantém uma permissão, uma
-- validação e uma transação: são o mesmo assunto (para quem vai o aviso), e uma
-- segunda RPC `definer` só criaria outra porta para o mesmo dado, com o mesmo
-- `admin` e a mesma exigência de MFA repetidos. A assinatura antiga (7
-- argumentos) é derrubada no fim — sobrecarga viva é chamada errada esperando
-- acontecer.
--
-- ─── Baseline ──────────────────────────────────────────────────────────────
--
-- Colunas no bloco de `config_aviso_de_caso`, `alter table ... add column if not
-- exists` para o clone que já tem a tabela, e o corpo de
-- `fn_definir_aviso_de_caso` EDITADO NO LUGAR na última definição (mesmo desenho
-- da 0426/0513/9063). As duas colunas de `user_organizations` entram por
-- apêndice, porque a tabela nasce no corpo do dump.

-- ---- as colunas ----
alter table public.config_aviso_de_caso
  add column if not exists destino_modo text not null default 'fixo';

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_destino_modo_valido;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_destino_modo_valido
  check (destino_modo in ('fixo', 'responsavel'));

alter table public.user_organizations
  add column if not exists whatsapp_e164 text;

-- A MESMA forma do CHECK de `config_aviso_de_caso_e164`: o número do membro vai
-- para o mesmo transporte, e um valor torto aqui só apareceria como falha de
-- envio meses depois.
alter table public.user_organizations
  drop constraint if exists user_organizations_whatsapp_e164_valido;
alter table public.user_organizations
  add constraint user_organizations_whatsapp_e164_valido
  check (whatsapp_e164 is null or whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$');

-- ---- a porta de escrita ----
create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_resposta_whatsapp_habilitada boolean default false,
  p_destino_modo text default 'fixo',
  p_responsaveis jsonb default null
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
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, resposta_whatsapp_habilitada, destino_modo, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), coalesce(p_resposta_whatsapp_habilitada, false), v_modo, auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
        resposta_whatsapp_habilitada = excluded.resposta_whatsapp_habilitada,
        destino_modo       = excluded.destino_modo,
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
revoke all on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb) to authenticated;
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean);
