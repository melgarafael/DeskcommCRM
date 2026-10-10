-- ═══════════════════════════════════════════════════════════════════════════
-- 0438 — O número de uma conexão ARQUIVADA volta a poder receber os avisos.
--
-- ─── O que não existia ────────────────────────────────────────────────────
--
-- A 0292 fechou o laço robô-com-robô do aviso de caso assim: o número de destino
-- não pode ser um número DA PRÓPRIA ORGANIZAÇÃO. A consulta pergunta por
-- `channel_sessions` da organização — e não pergunta se a conexão está ATIVA.
--
-- Consequência medida numa instalação de produção (relato reproduzido na issue):
-- a conexão arquivada continua contando como número da organização. Quem
-- removeu a conexão A e escolheu A como destino do aviso recebe
-- `aviso_de_caso_numero_da_propria_org` — e o bloqueio é DEFINITIVO, porque
-- existe o outro lado: uma conexão que já teve agente publicado não pode ser
-- apagada (`ai_agent_versions.channel_session_id` é ON DELETE RESTRICT e o
-- gatilho de imutabilidade recusa soltar a coluna de uma versão publicada ou
-- superseded). As duas regras fazem sentido sozinhas; juntas, o número de uma
-- conexão que já teve agente nunca mais recebe aviso. A saída relatada foi
-- apagar o agente, as versões, os runs, os rascunhos, as conversas e, por fim, a
-- conexão — o que não é aceitável numa instalação em produção.
--
-- ─── A correção ───────────────────────────────────────────────────────────
--
-- A conexão arquivada ENTRA na mesma regra que o resto do sistema já aplica a
-- ela: `channel_sessions_phone_per_org_unique` é índice ÚNICO PARCIAL
-- (`where archived_at is null`, migration 0107) e `listSelectableChannels`
-- não a oferece. Ela está fora do ar — não envia e não recebe —, então o laço
-- que esta checagem evita não pode acontecer por causa dela. Com o filtro, o
-- número volta a ser um destino válido sem enfraquecer nada do que a 0292
-- protegia: qualquer conexão ATIVA com aquele número (nas duas grafias do nono
-- dígito) continua recusada, que é o caso do laço.
--
-- ─── Por que uma migration nova ───────────────────────────────────────────
--
-- A 0292 está aplicada e NÃO é editada (doutrina de migrations). Esta redefine a
-- função inteira com `create or replace`, mesma assinatura e o MESMO par
-- `revoke`/`grant` (repetido de propósito, para o arquivo ser autocontido).
-- Sem coluna, sem dado tocado, sem policy nova.
--
-- ─── O caminho do self-host ───────────────────────────────────────────────
--
-- O kit aplica só o `baseline.sql`. O bloco da 0292 no apêndice é EDITADO NO
-- LUGAR (mesmo desenho das 0417/0426/0434/0435): se ficasse como está e um bloco
-- novo viesse depois, quem aplica a cadeia de migrations receberia uma coisa e
-- quem aplica o baseline receberia outra. O gate
-- `apendice-do-baseline-nao-diverge-da-cadeia` cobra exatamente isso.
--
-- Gate: `tests/unit/aviso-de-caso-nao-conta-conexao-arquivada.test.ts` mede as
-- duas definições (cadeia e apêndice) e a igualdade entre elas. E
-- `tests/invariants/aviso-de-caso-escrita.test.ts` ganhou o caso de Postgres
-- real: o número de uma conexão ARQUIVADA passa, o da MESMA conexão ativa
-- continua recusado.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false
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

  select * into v_antes from public.config_aviso_de_caso where organization_id = p_org;

  insert into public.config_aviso_de_caso
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
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
    'antes_ligado',  coalesce(v_antes.ligado, false)
  );
end;
$$;
-- AS DUAS ORIGENS DE EXECUTE (item 9 da doutrina de migrations): o grant direto
-- a `anon` do `ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS TO anon` do
-- baseline (que `revoke from public` não remove) e o grant implícito a PUBLIC
-- que o Postgres dá a toda função ao criá-la (que `revoke from anon` não
-- remove). Fechar uma só deixa a função exposta com o gate verde.
revoke all     on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean) from public, anon;
grant  execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean) to authenticated;
