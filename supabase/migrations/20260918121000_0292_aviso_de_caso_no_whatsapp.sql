-- ═══════════════════════════════════════════════════════════════════════════
-- 0292 — O WhatsApp da equipe é avisado quando a IA abre um caso.
--
-- ─── O que não existia ────────────────────────────────────────────────────
--
-- A IA abre um caso quando trava (`agent_cases`), o caso entra numa fila e
-- espera alguém da equipe. O único lugar onde ele APARECE é uma tela do CRM —
-- e quem opera uma PME não fica com o CRM aberto: fica com o WhatsApp aberto.
-- O cobrador de caso parado (`app/api/v1/cron/case-stale-watcher`) só reclama
-- DEPOIS de horas, e reclama na mesma tela que ninguém abriu. O resultado
-- medido é um cliente esperando do outro lado sem que ninguém tenha sido
-- avisado de nada.
--
-- Esta migration é o SCHEMA e as RPCs desse aviso. A tela que o liga é a onda
-- seguinte; o motor que o envia (`lib/escalacao/aviso-ao-suporte.ts`) entra no
-- MESMO commit que este arquivo.
--
-- ─── DOUTRINA DIRC, respondida ────────────────────────────────────────────
--
--   Duplicar   — não: não existe hoje nenhuma tabela de "para onde mandar
--                aviso interno" (`organizations.settings` guarda preferência de
--                produto, não vínculo com `channel_sessions`);
--   Integrar   — `channel_session_id` e `case_id` são FK, não cópias;
--   Referenciar— `status` e `erro_codigo` são vocabulário fechado;
--   Calcular   — "este aviso já saiu?" NÃO é calculável depois: sem a linha de
--                entrega, o único jeito de saber seria reler o WhatsApp da
--                equipe, e a segunda rodada do dreno mandaria de novo.
--
-- ─── AS DUAS TABELAS, e por que são duas ──────────────────────────────────
--
--   `config_aviso_de_caso`    — UMA linha por organização: para onde mandar,
--                               por qual conexão, ligado ou não.
--   `entregas_de_aviso_de_caso` — UMA linha por (organização, caso, destino).
--                               É a `unique` dela que dá a IDEMPOTÊNCIA: o
--                               dreno do `event_log` reentrega o mesmo evento
--                               em retry, e sem essa chave a equipe receberia o
--                               mesmo aviso três vezes.
--
-- **O TEXTO DO AVISO NUNCA É GUARDADO.** Só `corpo_hash` — precedente
-- `send_ledger.body_hash`. Um registro de entrega que guardasse o corpo seria
-- uma segunda cópia do relato do cliente, numa tabela que a cascata de LGPD
-- teria de aprender a redigir. A única coluna capaz de ecoar um dado pessoal é
-- `erro_detalhe` (o texto cru do transporte), e é ela que a cascata zera.
--
-- ─── POR QUE NÃO HÁ `check (ligado = false or channel_session_id is not null)`
--
-- Ele parece a expressão natural de "ligado sem canal nunca dispara", e é uma
-- armadilha: `on delete set null` é um UPDATE, o CHECK é reavaliado na linha
-- resultante e VIOLA quando `ligado` é `true` — abortando o DELETE INTEIRO da
-- conexão. A rota de exclusão de canal devolveria 500 com mensagem de
-- constraint, sem nenhuma pista de que a causa está em outra tela. A coerência
-- é do trigger `trg_aviso_de_caso_coerente`, que se autocura: canal nulo ⇒
-- `ligado` cai para `false`, e a tela explica o que houve.
--
-- ─── POR QUE A ESCRITA É POR RPC E A LEITURA É POR RLS ────────────────────
--
-- Padrão vigente da 0228 e da 0262. A escrita precisa de quatro guardas na
-- MESMA transação (papel `admin`, escrita de suporte liberada, MFA comprovada
-- quando há fator, e o canal sendo da própria organização) — e uma policy não
-- sabe recusar "este número já é de um cliente seu". A leitura da CONFIGURAÇÃO
-- é `admin` (quem configura conexão é admin); a do HISTÓRICO é `manager`,
-- porque "o aviso está saindo?" é pergunta de quem opera o atendimento.
-- Nenhuma policy `for all` ⇒ as duas tabelas nascem fora da consulta `cmd='ALL'`
-- do gate de RBAC, sem entrar em dívida nova.
--
-- ─── AS DUAS COLUNAS DE CONTAGEM NÃO SÃO ENFEITE ──────────────────────────
--
-- `mensagens_ignoradas` / `ultima_mensagem_ignorada_em` existem porque a onda
-- do corte (o número de aviso é INTERNO: nada que venha dele vira contato,
-- conversa, lead ou despacho do agente) produz um silêncio que, na tela, é
-- indistinguível de defeito. Com elas a tela diz "3 mensagens deste número
-- foram ignoradas nos últimos 7 dias — é o esperado". Quem incrementa é
-- `fn_contar_mensagem_ignorada`, e ela NÃO toca `updated_at`: aquele carimbo
-- responde "quando alguém mexeu na configuração", e uma resposta do suporte não
-- é alguém mexendo na configuração.
--
-- ─── REAPLICAÇÃO ──────────────────────────────────────────────────────────
--
-- `create table if not exists`, `add column if not exists`, `drop constraint if
-- exists` + `add constraint`, `create index if not exists`, `drop policy if
-- exists` + `create policy`, `create or replace function`, `drop trigger if
-- exists` + `create trigger`. O `update.sh` de um clone reaplica sem erro e sem
-- duplicar efeito. Nenhuma constraint nova sobre dados existentes (as duas
-- tabelas nascem aqui, e os dois CHECK de vocabulário só CRESCEM) ⇒ não há
-- deduplicação prévia a fazer (regra 8 da doutrina de migrations).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.config_aviso_de_caso (
  organization_id     uuid primary key references public.organizations(id) on delete cascade,
  -- NULLABLE de propósito, e `set null` e não `cascade`/`restrict`: com
  -- `cascade` a exclusão do canal apagaria a configuração CALADA; com
  -- `restrict`, a exclusão do canal falharia por causa de um aviso. `set null`
  -- desliga (pelo trigger) e deixa a tela explicar.
  channel_session_id  uuid references public.channel_sessions(id) on delete set null,
  -- E.164, com `+`. É o que a pessoa digita e o que o transporte recebe.
  telefone_destino    text not null,
  -- O JID que o transporte resolveu da última vez. É o que faz o corte da
  -- ingestão funcionar para destinatário em MODO PRIVACIDADE, onde o telefone
  -- nunca chega no webhook e o chat chega como um identificador opaco.
  destino_jid         text,
  -- Como a equipe chama esse número ("Plantão", "Suporte 1"). Só rótulo.
  rotulo              text,
  ligado              boolean not null default false,
  -- A SUPERFÍCIE DO DESCARTE (ver o cabeçalho): sem elas, "as mensagens deste
  -- número somem" é indistinguível de defeito para quem olha a tela.
  mensagens_ignoradas         integer not null default 0,
  ultima_mensagem_ignorada_em timestamptz,
  criado_por          uuid references auth.users(id) on delete set null,
  atualizado_por      uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  -- Responde "quando alguém MEXEU na configuração" — e só isso. O contador de
  -- mensagens ignoradas não o toca de propósito.
  updated_at          timestamptz not null default now()
);

-- Colunas declaradas de novo para o clone que já tenha a tabela de uma versão
-- anterior deste arquivo: `add column if not exists` é o que torna o apêndice
-- auto-curativo.
alter table public.config_aviso_de_caso
  add column if not exists destino_jid                 text,
  add column if not exists rotulo                      text,
  add column if not exists mensagens_ignoradas         integer not null default 0,
  add column if not exists ultima_mensagem_ignorada_em timestamptz,
  add column if not exists criado_por                  uuid,
  add column if not exists atualizado_por              uuid;

-- As constraints nomeadas fora do `create table`: é o que as torna
-- auto-curativas num clone cuja tabela nasceu de uma versão anterior. O nome é
-- o MESMO que o Postgres daria ao inline, então não há duas constraints
-- definindo o mesmo domínio — duas fariam o invariante de vocabulário se
-- RECUSAR a medir.
alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_e164;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_e164
  check (telefone_destino ~ '^\+[1-9][0-9]{7,14}$');

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_rotulo_curto;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_rotulo_curto
  check (rotulo is null or char_length(rotulo) <= 60);

-- Coerência que se AUTOCURA, em vez de um CHECK que aborta o DELETE da conexão
-- (ver o cabeçalho). `before insert or update` para valer também quando o
-- `on delete set null` da FK dispara o UPDATE.
create or replace function public.fn_aviso_de_caso_coerente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Sem canal não há por onde mandar. Deixar `ligado = true` aqui produziria a
  -- pior tela possível: a que diz que o aviso está ativo enquanto ele nunca
  -- dispara. `security invoker` de propósito — ela não lê nem escreve nada além
  -- da linha que o próprio comando já está tocando.
  if new.channel_session_id is null then
    new.ligado := false;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_aviso_de_caso_coerente() from public, anon, authenticated;

drop trigger if exists trg_aviso_de_caso_coerente on public.config_aviso_de_caso;
create trigger trg_aviso_de_caso_coerente
  before insert or update on public.config_aviso_de_caso
  for each row execute function public.fn_aviso_de_caso_coerente();

create table if not exists public.entregas_de_aviso_de_caso (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  case_id             uuid not null references public.agent_cases(id)   on delete cascade,
  -- O destino NO INSTANTE do envio. Não é FK para a configuração de propósito:
  -- trocar o número do plantão não pode reescrever para onde os avisos de ontem
  -- foram — isso é registro, não estado.
  destino             text not null,
  channel_session_id  uuid references public.channel_sessions(id) on delete set null,
  status              text not null default 'pendente',
  tentativas          smallint not null default 0,
  -- Vocabulário FECHADO (lib/escalacao/vocabulario-do-aviso.ts), nunca a
  -- mensagem do provedor: é o que a tela lê e o que a Central traduz.
  erro_codigo         text,
  -- O texto cru do transporte, truncado. ÚNICA coluna desta tabela capaz de
  -- ecoar um dado pessoal — e é por isso que a cascata de LGPD a zera.
  erro_detalhe        text,
  external_id         text,
  -- O TEXTO NUNCA É GUARDADO (precedente: `send_ledger.body_hash`). O hash
  -- responde "o aviso que saiu era este?" sem guardar o relato do cliente uma
  -- segunda vez.
  corpo_hash          text,
  enviado_em          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.entregas_de_aviso_de_caso
  add column if not exists channel_session_id uuid,
  add column if not exists erro_codigo        text,
  add column if not exists erro_detalhe       text,
  add column if not exists external_id        text,
  add column if not exists corpo_hash         text,
  add column if not exists enviado_em         timestamptz;

alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_status_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_status_check
  check (status in ('pendente', 'enviado', 'falhou', 'cancelado'));

alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_erro_codigo_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_erro_codigo_check
  check (erro_codigo is null or erro_codigo in (
    'canal_desconectado',
    'canal_arquivado',
    'canal_nao_aceita_aviso_livre',
    'transporte_ausente',
    'destino_invalido',
    'teto_diario_do_numero',
    'sem_endereco_publico',
    'titular_anonimizado',
    'expirou',
    'falha_no_envio',
    'indeterminado'));

-- A CHAVE DA IDEMPOTÊNCIA. O dreno do `event_log` reentrega o mesmo evento em
-- retry e três processos diferentes drenam a mesma fila: sem esta unique, a
-- equipe receberia o mesmo aviso uma vez por tentativa. O `23505` dela é o
-- sinal que o handler lê para REIVINDICAR a entrega antes de tocar a rede.
create unique index if not exists entregas_de_aviso_de_caso_unica
  on public.entregas_de_aviso_de_caso (organization_id, case_id, destino);

-- O leitor declarado: a lista "os últimos avisos" da tela de configuração, que
-- é a fonte da verdade sobre "o aviso está saindo?" (a Central pode ter tido o
-- item apagado por qualquer membro; esta tabela, não).
create index if not exists entregas_de_aviso_de_caso_org_idx
  on public.entregas_de_aviso_de_caso (organization_id, created_at desc);

-- `updated_at` da ENTREGA é operacional: ele responde "há quanto tempo esta
-- reivindicação está de pé?", e é ele que separa "outro processo está enviando
-- agora" de "alguém morreu no meio". Por isso a entrega ganha o trigger e a
-- CONFIGURAÇÃO não: lá o carimbo significa "alguém mexeu", e um contador de
-- mensagem ignorada não é alguém mexendo.
drop trigger if exists trg_entregas_de_aviso_de_caso_updated_at on public.entregas_de_aviso_de_caso;
create trigger trg_entregas_de_aviso_de_caso_updated_at
  before update on public.entregas_de_aviso_de_caso
  for each row execute function public.fn_set_updated_at();

alter table public.config_aviso_de_caso      enable row level security;
alter table public.entregas_de_aviso_de_caso enable row level security;

-- `revoke all` PRIMEIRO: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO
-- "authenticated"` do baseline vem ANTES de toda tabela de apêndice, então sem
-- ele as tabelas nascem com INSERT/UPDATE/DELETE para `authenticated` e a
-- policy seria a única coisa entre um `viewer` e a escrita. É o defeito que a
-- 0279 teve de consertar em três tabelas já nascidas.
revoke all    on public.config_aviso_de_caso      from anon, authenticated;
revoke all    on public.entregas_de_aviso_de_caso from anon, authenticated;
grant  select on public.config_aviso_de_caso      to authenticated;
grant  select on public.entregas_de_aviso_de_caso to authenticated;
grant  all    on public.config_aviso_de_caso      to service_role;
grant  all    on public.entregas_de_aviso_de_caso to service_role;

-- Leitura da CONFIGURAÇÃO: `admin`. Ela carrega o telefone de um funcionário e
-- o vínculo com a conexão — quem configura conexão neste produto é admin.
drop policy if exists leitura_config_aviso_de_caso on public.config_aviso_de_caso;
create policy leitura_config_aviso_de_caso
  on public.config_aviso_de_caso
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- Leitura do HISTÓRICO: `manager`. "O aviso está saindo?" é pergunta de quem
-- opera o atendimento, e a linha não expõe o número inteiro para a tela (que o
-- mascara) nem guarda texto nenhum.
drop policy if exists leitura_entregas_de_aviso_de_caso on public.entregas_de_aviso_de_caso;
create policy leitura_entregas_de_aviso_de_caso
  on public.entregas_de_aviso_de_caso
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- ── A escrita da configuração: uma RPC, quatro guardas, uma transação ──────
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
  if exists (
       select 1 from public.channel_sessions s
        where s.organization_id = p_org
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

-- ── O JID que o transporte resolveu ───────────────────────────────────────
-- Função SEPARADA, e não `update` direto pelo handler: dar `update` da
-- configuração ao service role abriria o caminho de "o motor mudou o número de
-- destino sozinho". Aqui ele só pode gravar UM campo, o que ele mesmo resolveu.
create or replace function public.fn_registrar_jid_do_aviso(p_org uuid, p_jid text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org is null or p_jid is null or btrim(p_jid) = '' then
    return;
  end if;
  -- `is distinct from` para não gastar um UPDATE (e o trigger de coerência) a
  -- cada aviso enviado: o JID muda uma vez e depois é sempre o mesmo.
  -- `updated_at` FICA FORA: ele responde "alguém mexeu na configuração".
  update public.config_aviso_de_caso
     set destino_jid = p_jid
   where organization_id = p_org
     and destino_jid is distinct from p_jid;
end;
$$;
revoke all     on function public.fn_registrar_jid_do_aviso(uuid,text) from public, anon, authenticated;
grant  execute on function public.fn_registrar_jid_do_aviso(uuid,text) to service_role;

-- ── O contador do descarte ────────────────────────────────────────────────
-- Chamada pelos ingestores quando uma mensagem do número interno é descartada.
-- Sem ela o silêncio é indistinguível de defeito para quem olha a tela.
create or replace function public.fn_contar_mensagem_ignorada(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org is null then
    return;
  end if;
  -- `updated_at` FICA FORA, de propósito: uma resposta do suporte não é alguém
  -- mexendo na configuração, e a tela usa aquele carimbo para dizer "alterado
  -- por Fulano em tal dia".
  update public.config_aviso_de_caso
     set mensagens_ignoradas = mensagens_ignoradas + 1,
         ultima_mensagem_ignorada_em = now()
   where organization_id = p_org;
end;
$$;
revoke all     on function public.fn_contar_mensagem_ignorada(uuid) from public, anon, authenticated;
grant  execute on function public.fn_contar_mensagem_ignorada(uuid) to service_role;

-- ── Retenção: a tabela nasce com dono de piso ─────────────────────────────
create or replace function public.fn_expurgar_avisos_de_caso_vencidos(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 180 dias: mais curto que a auditoria (5 anos) porque a pergunta útil — "o
  -- aviso daquele caso saiu?" — é de semanas, não de anos. O piso de 30 impede
  -- que o knob vire apagador do rastro de um incidente que ainda está sendo
  -- apurado, e mora AQUI, no corpo, porque só assim vale para QUALQUER
  -- chamador, inclusive um `psql` na mão.
  v_dias int := greatest(coalesce(p_retencao_dias, 180), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select e.id from public.entregas_de_aviso_de_caso e
     where e.created_at < now() - make_interval(days => v_dias)
     order by e.created_at
     limit v_limite
  )
  delete from public.entregas_de_aviso_de_caso e using vencidas v where e.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke all     on function public.fn_expurgar_avisos_de_caso_vencidos(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_avisos_de_caso_vencidos(int,int) to service_role;

-- ╭──────────────────────────────────────────────────────────────────────────
-- │ SÓ NA CADEIA DE MIGRATIONS — este trecho NÃO vai para o apêndice.
-- │
-- │ As duas constraints de vocabulário têm UM bloco só no `supabase/
-- │ baseline.sql`, e esse bloco é editado EM LUGAR (o valor novo entra no fim
-- │ da lista de lá). Um segundo bloco no apêndice é o defeito da issue #159:
-- │ num banco com uma linha do vocabulário mais novo, o bloco antigo falha ao
-- │ reaplicar e a tabela fica sem constraint nenhuma entre o `drop` e o `add`
-- │ que funciona. `tests/unit/baseline-constraint-reconstruida.test.ts` reprova.
-- │
-- │ Aqui, na cadeia, a reconstrução é obrigatória e com a lista INTEIRA:
-- │ `tests/unit/kind-check-migration-x-baseline.test.ts` exige que a ÚLTIMA
-- │ migration que reconstrói a constraint bata com o baseline valor a valor —
-- │ foi assim que a 0129 encolheu o vocabulário para quem aplica migrations em
-- │ ordem, apagando três valores em silêncio.
-- ╰──────────────────────────────────────────────────────────────────────────

-- `alert_sent` — a linha do tempo do caso passa a registrar que a equipe foi
-- avisada no WhatsApp. UM valor só: a FALHA vai para a Central, e dois kinds
-- seriam vocabulário para uma superfície que não existe.
alter table public.agent_case_events
  drop constraint if exists agent_case_events_kind_check;
alter table public.agent_case_events
  add constraint agent_case_events_kind_check check (kind in (
    'opened',
    'human_replied',
    'lead_asked',
    'lead_provided',
    'lead_unresponsive',
    'resolved',
    'escalated',
    'cancelled',
    'agent_noted',
    'alert_sent'
  ));

-- `aviso_de_caso_nao_entregue` — a falha DEFINITIVA do aviso vira item da
-- Central, com `ref_kind='agent_case'`, para levar AO CASO e não a uma tela
-- genérica. A fonte da verdade continua sendo `entregas_de_aviso_de_caso`:
-- qualquer membro apaga um item da Central pelo PostgREST hoje, então "não há
-- item aberto" nunca pode ser lido como "está tudo bem".
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'other',
    'aviso_de_caso_nao_entregue'
  ));

-- ╭──────────────────────────────────────────────────────────────────────────
-- │ FIM: SÓ NA CADEIA DE MIGRATIONS
-- ╰──────────────────────────────────────────────────────────────────────────

-- ── A cascata de LGPD alcança o registro de entrega ───────────────────────
-- Derivada do corpo VIGENTE do baseline (a definição de maior número de linha),
-- por script, nunca redigitada: o corpo anterior fica byte a byte igual e as
-- ÚNICAS mudanças são as duas declaradas — o passo de `entregas_de_aviso_de_caso`
-- e o `aviso_de_caso_nao_entregue` acrescentado ao `kind in (...)` do passo de
-- `agent_inbox_items`. O Postgres troca o corpo INTEIRO num `create or replace`;
-- quem derivar da versão errada apaga o passo de outra entrega sem um único
-- erro. A catraca que vigia isso é
-- `tests/invariants/cascata-lgpd-nao-encolhe.test.ts`.
CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    -- O motivo CRU da última passagem (migration 0291). É código de
    -- vocabulário, não texto livre — mas ele diz que ESTA pessoa foi escalada
    -- por irritação, por assunto jurídico ou por suspeita de opt-out, e isso é
    -- um fato sobre ela. Entra NESTE update, e não num segundo: mesmo
    -- predicado, mesmas linhas, metade das varreduras.
    --
    -- ⚠️ `last_handoff_reason` é CHAVE DE NEGÓCIO em outro módulo: a ponte de
    -- voz limpa o silêncio filtrando pelo VALOR da coluna
    -- (`lib/wacalls/events-bridge.ts`). Zerá-la num contato anonimizado é
    -- seguro — não há chamada viva de contato anonimizado — e é a razão de
    -- esta entrega NÃO usar essa coluna para texto rico: ela continua
    -- recebendo só o código, e o texto vive em `passagens_de_atendimento`.
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  --
  -- `peer_phone` é `not null` e guarda o número da outra ponta: depois de
  -- anonimizar o contato, ele sobrevivia ligado ao `contact_id` e reidentificava
  -- a pessoa que pediu para ser esquecida. É o mesmo argumento que a foto de
  -- perfil já tinha (ver o bloco do avatar em `lib/lgpd/redact-cascade.ts`):
  -- anonimizar em toda parte menos numa é não ter anonimizado.
  --
  -- O que fica: direção, status, motivo do fim, marcas de tempo e duração. Um
  -- registro de "houve uma chamada de 12 minutos" sem número e sem dono não
  -- identifica ninguém e é o que sustenta a métrica do atendente e a fatura.
  -- `peer_phone` é NOT NULL, então recebe o rótulo, não `null`.
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
  --
  -- O caso é o texto que a equipe lê antes de decidir: `title`, `summary` e
  -- `blocker` saem do modelo a partir da conversa, e `context_snapshot` é o
  -- recorte dessa conversa que o motor mandou para ele. Nada disso é registro de
  -- operação — é o relato do problema de uma pessoa identificável, escrito por
  -- máquina. Sem este passo, anonimizar devolvia SUCESSO com o relato intacto.
  --
  -- As três colunas de texto são `not null`: recebem rótulo e texto fixo, nunca
  -- `null` (a mesma razão de `voice_calls.peer_phone` logo acima).
  --
  -- ⚠️ `updated_at` FICA FORA DO `set`, de propósito. O cobrador de caso parado
  -- (`app/api/v1/cron/case-stale-watcher/route.ts`) lê `updated_at` como "alguém
  -- da equipe encostou neste caso". A cascata não é alguém encostando: escrever
  -- ali faria a anonimização ADIAR a cobrança de um caso que continua parado, e
  -- o efeito só apareceria como um cliente esperando mais tempo.
  --
  -- O vínculo é pela CONVERSA porque `agent_cases` não tem FK para `contacts`.
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- agent_case_events — a linha do tempo do caso (migration 0280).
  --
  -- `body` é o que a pessoa da equipe escreveu ao responder o caso e o que o
  -- agente registrou sobre o que o LEAD respondeu; `metadata` carrega o recorte
  -- que o motor anexou. `kind`, `actor_kind`, `human_action` e `created_at`
  -- FICAM: são o registro de que houve um toque humano e quando — operação, não
  -- dado da pessoa, e é deles que sai a métrica de atendimento.
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- demandas — o assunto do pedido (migration 0280).
  --
  -- `assunto` é texto livre sobre o que a pessoa pediu. O resto da linha é a
  -- operação da demanda (origem, estado, dono, prazo, desfecho) e fica de pé:
  -- apagar a linha inteira tiraria da organização a resposta a "quantos pedidos
  -- houve em março", que é o mesmo argumento do compromisso da agenda.
  --
  -- FK direta (`demandas.contact_id` é `not null`), então o vínculo é o contato.
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280).
  --
  -- O `body` do aviso de caso parado EMBUTE o título do caso
  -- (`app/api/v1/cron/case-stale-watcher/route.ts:128`), e o do handoff embute o
  -- motivo da parada (`lib/ai/handoff/orchestrator.ts:335`). Redigir o caso e
  -- deixar o aviso de pé seria anonimizar em toda parte menos numa — que é não
  -- ter anonimizado. O molde (resolver + trocar o corpo + soltar a referência) é
  -- o de `fn_meet_redact_contact`, que já faz isto para o aviso de compromisso.
  --
  -- ⚠️ O VÍNCULO É POLIMÓRFICO E TEM TRÊS BRAÇOS, não dois. Medido nos
  -- produtores, não suposto: `handoff` nasce com `ref_kind='contact'`
  -- (`lib/ai/handoff/orchestrator.ts:339`) E com `ref_kind='conversation'`
  -- (`lib/agent-engine/agent/inbound-turn.ts:4100`); `case_stale` nasce SEMPRE
  -- com `ref_kind='agent_case'` (a rota do cron acima, e a política em
  -- `lib/ai/inbox-destino.ts:38`). Um predicado com só os dois primeiros braços
  -- casa ZERO avisos de caso parado — e casar zero linha não é erro: é sucesso
  -- com o texto intacto.
  --
  -- Os `kind` são os MEDIDOS no CHECK vigente (`supabase/baseline.sql`, bloco
  -- único de `agent_inbox_items_kind_check`). `case_opened` NÃO existe, e kind
  -- inexistente num `in (...)` também casa zero e devolve sucesso. Para
  -- reconferir sem acreditar nesta prosa:
  --   grep -n "agent_inbox_items_kind_check check" -A40 supabase/baseline.sql
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    -- `aviso_de_caso_nao_entregue` (migration 0292) entra AQUI e não num
    -- passo próprio: é o mesmo predicado polimórfico, e o braço
    -- `ref_kind='agent_case'` já alcança o caso do titular. O corpo do aviso
    -- embute o título do caso, que é texto sobre a pessoa.
    and kind in ('handoff', 'case_stale', 'aviso_de_caso_nao_entregue')
    and (
      (ref_kind = 'contact' and ref_id = p_contact_id)
      or (ref_kind = 'conversation' and ref_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          ))
      or (ref_kind = 'agent_case' and ref_id in (
            select id from agent_cases
              where organization_id = p_organization_id
                and conversation_id in (
                  select id from conversations
                    where contact_id = p_contact_id and organization_id = p_organization_id
                )
          ))
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso
  -- (migration 0281). FK DIRETA para `contacts`, então o vínculo é o titular e
  -- não precisa passar pela conversa.
  --
  -- `redacted_at is null` no `where` é o que torna o passo IDEMPOTENTE: a
  -- varredura diária de redações incompletas roda a função de novo, e sem essa
  -- condição o carimbo de QUANDO se apagou seria reescrito a cada rodada.
  --
  -- A linha NÃO é apagada, só o texto: quem abrir o caso depois continua vendo
  -- que a equipe perguntou N vezes, quando, e se a IA respondeu. Apagar a linha
  -- inteira ficaria verde num teste de "o texto sumiu" e tiraria da organização
  -- a resposta a "quanto a equipe deliberou sobre este caso".
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  --
  -- A linha guarda o que a IA concluiu sobre um atendimento de alguém
  -- identificável: o que ela entendeu que a pessoa quer (`title`), a narrativa
  -- que quem assumiu leu (`body`), as PALAVRAS LITERAIS do cliente (`notes`), o
  -- texto livre de quem passou (`content`) e o que a IA já tinha tentado
  -- (`tentativas`). Nada disso é registro de operação — é o relato do problema
  -- de uma pessoa, escrito por máquina, na tela de quem vai responder.
  --
  -- `body` é `not null` e recebe o RÓTULO, não `null` — a mesma razão de
  -- `voice_calls.peer_phone` e de `agent_cases.title` acima: coluna obrigatória
  -- anulada aborta o cascade INTEIRO, e um cascade abortado não anonimiza nada.
  --
  -- O que FICA, de propósito: `motor`, `origem`, `motivo_codigo`,
  -- `cliente_avisado`, `aviso_motivo_codigo`, `criado_em` e o par de
  -- reconhecimento. São operação — quantas passagens houve, por quê, quanto
  -- tempo até alguém assumir. Um passo que apagasse a linha inteira ficaria
  -- verde num teste de "o texto sumiu" e tiraria da organização a resposta a
  -- "quantos atendimentos a IA devolveu em março, e quanto tempo esperaram".
  --
  -- O vínculo é a FK DIRETA `contact_id`: a tabela a carrega exatamente para
  -- este passo não precisar passar pela conversa.
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  --
  -- A tabela NÃO guarda o texto do aviso (só `corpo_hash`), e a única coluna
  -- capaz de ecoar um dado da pessoa é `erro_detalhe`: ali vai o texto CRU que
  -- o transporte devolveu, truncado, e um provedor que recusa um envio costuma
  -- devolver o destinatário dentro da mensagem de erro.
  --
  -- O que FICA, de propósito: `status`, `erro_codigo`, `tentativas`,
  -- `enviado_em`, `destino`, `corpo_hash`. São operação — quantos avisos saíram,
  -- quantos falharam e por quê. Um passo que apagasse a linha inteira ficaria
  -- verde num teste de "o texto sumiu" e tiraria da organização a resposta a
  -- "quantos avisos não chegaram em março". `destino` é o telefone da EQUIPE,
  -- não do titular: anonimizar um cliente não apaga o número do plantão.
  --
  -- ⚠️ PONTO CEGO DECLARADO: `tests/invariants/lgpd-cascata-alcanca-quem-
  -- guarda-pessoa.test.ts` só cobra tabela com FK para `contacts` E coluna cujo
  -- NOME case o padrão de PII. Esta tabela não satisfaz nenhuma das duas — o
  -- gate ficaria VERDE sem este passo. Ele entra porque é certo, não porque o
  -- gate cobra, e isto está escrito aqui para a próxima sessão não o remover
  -- achando que é ornamento. Quem o vigia é a catraca
  -- `tests/invariants/cascata-lgpd-nao-encolhe.test.ts`.
  --
  -- O vínculo é pela CONVERSA, como o de `agent_cases`: esta tabela aponta para
  -- o caso, e o caso não tem FK para `contacts`.
  update entregas_de_aviso_de_caso set
    erro_detalhe = null
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('entregas_de_aviso_de_caso', v_count);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;
revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

-- ── travas do suporte, depois de toda tabela nova (migration 0274) ─────────
-- `config_aviso_de_caso` e `entregas_de_aviso_de_caso` nascem com a escrita
-- fechada para `anon`/`authenticated` (revoke + grant select), então o ramo
-- server-only da função lhes dá ZERO policies `support_write_*` — que é o
-- contrato mais restritivo. Escrever `drop policy` à mão aqui seria a segunda
-- representação da mesma regra.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
