-- 0262 — cliente pela agenda: quem tem horário marcado vira cliente, SE a organização ligar
--
-- Contribuição de @423313 (PR #867). Ajustes da triagem pela decisão do dono do
-- produto (opção B): a regra nasce DESLIGADA e cada organização a liga; horário
-- cancelado e falta não contam; a etiqueta tirada à mão é respeitada; e quando o
-- sistema põe a etiqueta, as automações enxergam.
--
-- O PROBLEMA, medido pelo autor: `lib/leads/nascimento-do-lead.ts` abre um lead
-- no funil `is_default` para TODO número que escreve. Num estúdio com 630
-- contatos e a agenda inteira migrada, quem é cliente há anos entra no funil de
-- captação a cada "oi" — e o funil de entrada deixa de significar "gente nova".
-- Não havia coluna, flag ou tag que registrasse a diferença.
--
-- O GATILHO É O AGENDAMENTO, NÃO O COMPARECIMENTO: combinar hora já é relação
-- estabelecida. Mas só o agendamento que CONTA — `fn_situacao_conta_como_atendimento`
-- é o espelho SQL de `LIBERAM_O_HORARIO` (lib/agenda/ocupados.ts): o que libera o
-- horário (cancelado, falta) não faz cliente.
--
-- E A DATA É A DO COMBINADO, NÃO A DO HORÁRIO. `first_service_at` é
-- `min(least(created_at, starts_at))`. A versão anterior usava `min(starts_at)`,
-- e a própria evidência da entrega mostrou "Cliente desde 21/09/2026" numa ficha
-- capturada em 15/09 — uma data que ainda não chegou, contradizendo a razão
-- escrita logo acima. Com `least`, o histórico importado continua com a data
-- passada do atendimento, e a marcação de hoje para o mês que vem fica com hoje.
--
-- POR QUE DESLIGADA POR PADRÃO. Ligar reescreve etiquetas de toda a organização,
-- e uma etiqueta nova é gatilho de automação ("Quando um contato ganhar uma
-- tag" → enviar WhatsApp). Uma atualização do produto não pode fazer isso por
-- conta própria em todas as organizações de todas as instalações. Por isso NÃO
-- há backfill de classificação neste arquivo nem no apêndice do baseline: o
-- `update.sh` de quem já roda não etiqueta nenhum contato. O histórico é
-- classificado por `fn_definir_cliente_pela_agenda`, só na organização que liga,
-- só no instante em que liga, e SEM evento por contato.
--
-- A CHAVE: `organizations.settings.crm.cliente_pela_agenda`. Só o jsonb `true`
-- liga — ausente, `false`, `"true"` ou lixo é DESLIGADO. A mesma régua em
-- TypeScript é `clientePelaAgendaLigado` (lib/schemas/settings.ts). Não mora em
-- `settings.agenda` porque `fn_agenda_settings` substitui aquele objeto inteiro
-- e recusa chave extra.
--
-- POR QUE TRIGGER E NÃO CÓDIGO NO HANDLER (do autor, e continua valendo):
-- "`marcarAgendamentoHandler` é o único INSERT" é afirmação de estado que
-- envelhece; regra no chamador o próximo chamador não herda. E o trigger ouve
-- UPDATE e DELETE também: pela tela o horário nasce `pending` ou `confirmed`, a
-- falta só se registra depois, e um agent pode apagar o horário pela sessão
-- (policy `calendar_appointments_write`) — sem ouvir o DELETE o contato ficava
-- cliente, com data e etiqueta, de um horário que não existe mais.
--
-- A COLUNA MANDA, A ETIQUETA É DE TRABALHO. `first_service_at` decide o funil e
-- o selo; a tag `cliente` serve ao filtro, às automações e ao agente. E a
-- etiqueta tem DONO, gravado em `client_tag_by_system`:
--
--   - o sistema só TIRA a etiqueta que ele mesmo pôs. A versão anterior tirava
--     qualquer `cliente` na virada "era → deixou de ser", e medido: um contato
--     com {cliente,vip} postos à mão, que marcou e cancelou, ficou só com {vip}
--     — sem evento, sem auditoria, e "cliente" é justamente a palavra que uma
--     equipe brasileira já usa à mão;
--   - o sistema só REPÕE a etiqueta que ele mesmo tirou. Se a equipe tirou a
--     etiqueta do sistema, ela não volta — nem marcando outra hora, nem depois
--     de cancelar e marcar de novo.
--
-- E O DONO É LIDO NA ESCRITA DA ETIQUETA, não na próxima vez que a data muda.
-- A versão anterior reconciliava o dono só dentro de
-- `fn_recalcular_cliente_do_contato`, e DEPOIS do early-return `igual` — leitura
-- preguiçosa, com uma janela medida em Postgres descartável: o sistema põe a
-- etiqueta (`added`), a equipe tira à mão, a equipe REPÕE à mão (o dono continua
-- `added`, porque data nenhuma mudou) e o cancelamento seguinte tira a etiqueta
-- que a EQUIPE tinha posto. As duas frases acima eram, na prática, condicionais
-- — e ninguém as lê assim. Quem fecha a janela é
-- `fn_colunas_de_cliente_sao_do_sistema` (seção 4b), um BEFORE UPDATE em
-- `contacts`: mudou a presença da etiqueta sem o sistema ter gravado o dono na
-- MESMA escrita → a etiqueta passa a ser da equipe, e o sistema não a toca mais.
--
-- AS TRÊS COLUNAS SÃO DO SISTEMA, e isso é do banco, não da prosa. Elas nascem
-- com UPDATE para `authenticated`, e a única policy de escrita de `contacts` é
-- cega a papel: medido, uma sessão `viewer` da própria organização gravava
-- `first_service_at = '2019-01-01'` com `UPDATE 1`. A mesma seção 4b recusa
-- isso; o admin client (service role, `auth.uid()` nulo) continua passando.
--
-- O EVENTO SAI UMA VEZ POR CONTATO — e é na primeira vez que o sistema
-- ACRESCENTA A ETIQUETA, que não é a mesma coisa que "a primeira vez que ele
-- vira cliente". Quem já tinha a etiqueta posta à mão vira cliente sem que
-- etiqueta nenhuma entre, e ali `contact.tag_added` seria mentira: nada foi
-- acrescentado. O carimbo é `client_recognized_at`, que nunca volta a null.
-- Medido na versão anterior: um pedido `pending` que o cron
-- `agenda-expira-pendentes` cancela e que a pessoa refaz emitia DUAS vezes para
-- a mesma pessoa, e uma junção de contatos fazia a duplicata nova de uma
-- cliente de 2023 "ganhar a etiqueta" e disparar a automação de boas-vindas.
-- Quem volta a ser cliente ganha a etiqueta de volta, sem disparar de novo; o
-- repontamento de uma junção nunca emite. O PRIMEIRO VÍNCULO DE UM HORÁRIO QUE
-- NASCEU SEM CONTATO emite, e a razão está na seção 5: ele não é repontamento.
--
-- A ORDEM DAS TRAVAS É UMA SÓ: primeiro a da organização (advisory 262), depois
-- a do contato. Duas medições, as duas com `deadlock detected`, fizeram esta
-- regra: (1) `fn_mesclar_contatos` travava os contatos e só então o trigger do
-- repontamento pedia a trava da organização — a fusão caía com 500; (2) com
-- `for update` no recálculo, um INSERT comum de agendamento (a FK trava o
-- contato em `key share`, depois o trigger espera a trava da organização)
-- fechava ciclo com a ligação da regra. O recálculo passou a `for no key
-- update`, que não conflita com `key share`, e a fusão pega a trava da
-- organização antes de qualquer outra.
--
-- LAÇO DE RETORNO (quando a regra erra): a equipe tira a etiqueta à mão e isso é
-- respeitado para sempre; um administrador desliga a regra em Configurações ›
-- Tipos de agendamento; e a auditoria `crm.cliente_pela_agenda_alterado` mostra
-- quem ligou e quantos contatos ganharam e perderam a etiqueta.
--
-- CLONE QUE APLICOU UMA VERSÃO ANTERIOR (só bancos de desenvolvimento; nenhuma
-- esteve em release nem na main): `drop trigger if exists` + `create or
-- replace` substituem os triggers antigos, e a seção 1 marca como já
-- reconhecido quem tem `first_service_at` sem `client_recognized_at` — para
-- que esse contato não dispare automação ao voltar a marcar. As etiquetas
-- postas pelo backfill antigo ficam, e sem dono: o sistema nunca as tira.

-- ────────────────────────────────────────────────────────────────────────────
-- 1 · o fato, no contato
-- ────────────────────────────────────────────────────────────────────────────
alter table public.contacts
  add column if not exists first_service_at timestamptz;

comment on column public.contacts.first_service_at is
  'Quando a relação começou: o mais cedo entre marcar e o início do horário, entre os agendamentos que '
  'CONTAM (fn_situacao_conta_como_atendimento) — min(least(created_at, starts_at)). Histórico importado '
  'fica com a data passada; um horário marcado hoje para o mês que vem fica com hoje, nunca com data futura. '
  'Mantida pelos triggers de calendar_appointments (inserir, alterar, apagar) só enquanto '
  'organizations.settings.crm.cliente_pela_agenda = true; desligada, fica congelada e nenhuma TELA a '
  'mostra — o export de LGPD (lib/lgpd/export-collector.ts) e a API de contatos continuam levando o valor '
  'congelado, porque é dado guardado. Só o SISTEMA a grava: um BEFORE UPDATE recusa a escrita de sessão. '
  'Cancelar, marcar falta ou apagar o único horário que conta a devolve a null. Preservada na anonimização.';

alter table public.contacts
  add column if not exists client_recognized_at timestamptz;

comment on column public.contacts.client_recognized_at is
  'A PRIMEIRA vez que a regra cliente pela agenda reconheceu o contato como cliente: marcando, ao ligar a '
  'regra ou por junção de contatos. Nunca volta a null. É o que faz contact.tag_added sair uma vez por '
  'contato: quem já foi reconhecido não dispara as automações de novo ao voltar a marcar.';

alter table public.contacts
  add column if not exists client_tag_by_system text
    constraint contacts_client_tag_by_system_check
    check (client_tag_by_system in ('added', 'removed'));

comment on column public.contacts.client_tag_by_system is
  'De quem é a etiqueta cliente. added = o sistema pôs; removed = o sistema tirou a que ele mesmo pôs; '
  'null = o sistema nunca mexeu, ou a equipe assumiu (tirou a do sistema, ou pôs uma à mão). O sistema só '
  'tira a etiqueta que é dele e só repõe a que ele mesmo tirou. O que a equipe fez é lido NA HORA, pelo '
  'BEFORE UPDATE fn_colunas_de_cliente_sao_do_sistema — quem mexe na etiqueta sem gravar o dono na mesma '
  'escrita passa a ser o dono dela. Vocabulário só do banco: nenhum TypeScript lê ou grava.';

-- Auto-cura de banco que aplicou uma versão anterior desta migration: contato
-- com data e sem carimbo seria tratado como "nunca reconhecido" e dispararia a
-- automação ao voltar a marcar. Em instalação que nunca teve a coluna, zero
-- linhas — `first_service_at` nasce null em todo contato.
update public.contacts
   set client_recognized_at = now()
 where first_service_at is not null
   and client_recognized_at is null;

create index if not exists contacts_clientes_idx
  on public.contacts (organization_id, first_service_at desc)
  where first_service_at is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2 · onde o cliente que volta a escrever entra
-- ────────────────────────────────────────────────────────────────────────────
-- COLUNA, E NÃO CHAVE EM `crm_pipelines.settings` (do autor): papel do funil
-- dentro da organização já mora em coluna (`is_default`, `is_archived`), e só
-- com índice único quem cobra a exclusividade é o banco.
alter table public.crm_pipelines
  add column if not exists is_client_pipeline boolean not null default false;

comment on column public.crm_pipelines.is_client_pipeline is
  'Onde nasce o negocio de quem JA e cliente (contacts.first_service_at nao nulo). '
  'So tem efeito com organizations.settings.crm.cliente_pela_agenda ligado. '
  'Espelha is_default: booleano, exclusivo por organizacao, com tela em /app/kanban. '
  'Ausente e estado VALIDO, e e o de toda instalacao nova: sem funil marcado, o '
  'cliente nasce no funil padrao. Um mesmo funil pode ser padrao E de clientes.';

-- Cópia literal da forma de `uniq_crm_pipelines_org_default`, que é
-- `where (is_default = true)` — sem recorte de arquivado.
create unique index if not exists uniq_crm_pipelines_org_client
  on public.crm_pipelines (organization_id) where (is_client_pipeline = true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3 · a régua: que situação de agendamento conta como atendimento
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_situacao_conta_como_atendimento(p_status text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$ select p_status not in ('cancelled', 'no_show') $$;

comment on function public.fn_situacao_conta_como_atendimento(text) is
  'A agenda conta este status como atendimento? Espelho SQL de LIBERAM_O_HORARIO '
  '(lib/agenda/ocupados.ts): o que libera o horário não faz cliente. Vigiado por '
  'tests/invariants/cliente-nasce-do-agendamento.test.ts, que compara com '
  'SITUACOES_QUE_OCUPAM para todo status do vocabulário.';

revoke execute on function public.fn_situacao_conta_como_atendimento(text) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4 · o recálculo de UM contato — a única régua de transição
-- ────────────────────────────────────────────────────────────────────────────
-- Usado pelos triggers e pela ligação da regra. Devolve o que aconteceu, para
-- quem liga poder contar. `p_emitir` diz se ESTA escrita pode ser a virada que
-- as automações veem: o INSERT e a alteração de um horário podem; a ligação da
-- regra, o repontamento de uma junção e o horário apagado não.
create or replace function public.fn_recalcular_cliente_do_contato(p_org uuid, p_contact uuid, p_emitir boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_etiqueta constant text := 'cliente';
  v_antes timestamptz;
  v_tags text[];
  v_reconhecido timestamptz;
  v_dono text;
  v_depois timestamptz;
  v_tem boolean;
  v_novas text[];
  v_resultado text;
begin
  -- TRAVA O CONTATO ANTES DE LER A AGENDA. Na ordem inversa, duas marcações
  -- simultâneas do mesmo contato gravam um min() velho por cima do certo: em
  -- READ COMMITTED o min() lido DEPOIS da trava enxerga a marcação concorrente
  -- que já commitou.
  --
  -- `for no key update`, e não `for update`: é a trava que o UPDATE abaixo toma
  -- de qualquer jeito, e ela não conflita com o `for key share` que a FK de toda
  -- tabela que aponta para `contacts` toma num INSERT. Medido com `for update`:
  -- a ligação da regra (trava da organização, depois o contato) e um INSERT de
  -- agendamento (a FK trava o contato, depois o trigger espera a trava da
  -- organização) fechavam `deadlock detected`.
  --
  -- Anonimizado e mesclado não recebem escrita derivada nova: sem esta guarda
  -- um agendamento posterior faria "Cliente Anonimizado #N" reaparecer
  -- etiquetado.
  select c.first_service_at, coalesce(c.tags, '{}'::text[]), c.client_recognized_at, c.client_tag_by_system
    into v_antes, v_tags, v_reconhecido, v_dono
    from public.contacts c
   where c.organization_id = p_org
     and c.id = p_contact
     and c.is_anonymized = false
     and c.is_merged_into is null
   for no key update;
  if not found then
    return 'ignorado';
  end if;

  select min(least(a.created_at, a.starts_at)) into v_depois
    from public.calendar_appointments a
   where a.organization_id = p_org
     and a.contact_id = p_contact
     and public.fn_situacao_conta_como_atendimento(a.status);

  -- O caso comum — cliente antigo marcando a enésima hora — não escreve nada:
  -- `updated_at` não se move e o contato não vira ruído de realtime.
  if v_antes is not distinct from v_depois then
    return 'igual';
  end if;

  v_tem := c_etiqueta = any(v_tags);

  -- REDE, e não mais a regra: quem lê o que a equipe fez é a guarda da seção
  -- 4b, na hora da escrita. Isto aqui alcança os dois casos que ela não vê —
  -- um banco que aplicou uma versão anterior desta migration (a etiqueta mudou
  -- de mão antes de a guarda existir) e uma restauração com
  -- `session_replication_role = replica`, que desliga trigger.
  if (v_dono = 'added' and not v_tem) or (v_dono = 'removed' and v_tem) then
    v_dono := null;
  end if;

  -- `array_append`/`array_remove` e não `||`: sem cast, o `||` lê o literal
  -- como ARRAY e morre em `malformed array literal` (medido pelo autor no CI).
  v_novas := v_tags;
  if v_antes is null then
    -- Virou cliente. A etiqueta entra se nunca foi reconhecido (a primeira vez)
    -- ou se foi o sistema que a tirou. Se a equipe a tirou, fica fora.
    if not v_tem and (v_reconhecido is null or v_dono = 'removed') then
      v_novas := array_append(v_tags, c_etiqueta);
      v_dono := 'added';
      v_resultado := 'etiquetado';
    else
      v_resultado := 'virou_cliente';
    end if;
  elsif v_depois is null then
    -- Deixou de ser cliente. Só sai a etiqueta que é do sistema.
    if v_tem and v_dono = 'added' then
      v_novas := array_remove(v_tags, c_etiqueta);
      v_dono := 'removed';
      v_resultado := 'desetiquetado';
    else
      v_resultado := 'deixou_de_ser_cliente';
    end if;
  else
    v_resultado := 'mudou_a_data';
  end if;

  -- A ESCRITA SE ANUNCIA. `auth.uid()` continua preenchido aqui dentro — uma
  -- `security definer` troca o dono da função, nunca o JWT da sessão —, então
  -- sem um sinal explícito a guarda da seção 4b barraria o próprio sistema. A
  -- chave é de TRANSAÇÃO (`set_config(..., true)`) e volta a 'off' na linha
  -- seguinte: a janela é o UPDATE, não o resto da transação.
  perform set_config('deskcomm.cliente_pela_agenda', 'on', true);

  update public.contacts
     set first_service_at = v_depois,
         client_recognized_at = coalesce(v_reconhecido, case when v_depois is not null then now() end),
         client_tag_by_system = v_dono,
         tags = v_novas,
         updated_at = now()
   where organization_id = p_org
     and id = p_contact;

  perform set_config('deskcomm.cliente_pela_agenda', 'off', true);

  -- UMA VEZ POR CONTATO: só quando a etiqueta entra na primeira vez que a regra
  -- o reconhece.
  if v_resultado = 'etiquetado' and v_reconhecido is null and p_emitir then
    -- O MESMO formato que o app emite (app/api/v1/contacts/_handler.ts e
    -- lib/automation/actions/add-tag.ts): `added_tags` + `tags`.
    --
    -- SEM `service_origin`: `emit_event` o carimba sozinho para
    -- contact.tag_added, e o recusaria (42501) vindo de sessão autenticada.
    -- SEM `caused_by_rule`: a automação TEM de ver este evento.
    -- Trigger nunca faz HTTP: a linha vai para event_log e o worker consome.
    perform public.emit_event(
      'contact.tag_added',
      'contact',
      p_contact,
      jsonb_build_object('added_tags', jsonb_build_array(c_etiqueta), 'tags', to_jsonb(v_novas)),
      jsonb_build_object('actor_type', 'system', 'actor_id', 'trg_agendamento_marca_cliente'),
      p_org
    );
  end if;

  return v_resultado;
end $$;

revoke execute on function public.fn_recalcular_cliente_do_contato(uuid, uuid, boolean) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4b · as três colunas são do SISTEMA — e o dono da etiqueta é lido na escrita
-- ────────────────────────────────────────────────────────────────────────────
-- DUAS COISAS NUMA FUNÇÃO SÓ, e a ordem entre elas é a razão de não serem dois
-- triggers: BEFORE dispara por ordem ALFABÉTICA do nome, e a reconciliação
-- GRAVA `client_tag_by_system` — vindo depois da guarda, ela mesma seria
-- recusada. Aqui a guarda julga o que a ESCRITA trouxe, e só então o dono é
-- reconciliado.
--
-- (1) A GUARDA. As três colunas nascem com UPDATE para `authenticated` (o
--     `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES` que todo projeto
--     Supabase traz), e a única policy de escrita de `contacts` é cega a papel:
--     `tenant_isolation_contacts_all` é `organization_id in fn_user_org_ids()`,
--     sem `fn_role_at_least`. Medido num Postgres descartável, antes desta
--     seção: `set local role authenticated` com o JWT de um `viewer` — o papel
--     que a tela chama de "Somente leitura" — da PRÓPRIA organização gravava
--     `first_service_at = '2019-01-01'` e devolvia `UPDATE 1`. Isso é "Cliente
--     desde 2019" forjado; é o lead daquele contato passando a nascer no funil
--     de clientes (`lib/leads/nascimento-do-lead.ts` lê exatamente essa
--     coluna); e é `contact.tag_added` silenciado para sempre naquele contato,
--     porque `client_recognized_at` nunca volta a null. O limite multi-tenant
--     não caía — nada disso alcança outra organização —, mas dentro do tenant o
--     papel mais fraco decidia roteamento.
--
--     POR QUE TRIGGER E NÃO GRANT DE COLUNA, que é a forma da migration irmã
--     (0261 faz `revoke select on table` + `grant select (<lista>)`): lá a
--     tabela tem lista de colunas estável e o alvo é o SELECT. Aqui seria
--     `revoke update on table contacts` + `grant update (<todas as outras>)`, e
--     toda coluna acrescentada a `contacts` depois disto nasceria NÃO-gravável
--     por sessão nenhuma, em silêncio, até alguém lembrar de estender a lista.
--     A recusa nomeada custa um trigger e não deixa esse rastro.
--
--     `auth.uid() is null` PASSA de propósito: é o admin client (service role),
--     que resolve a organização de fonte confiável, e é o caminho da
--     anonimização de LGPD, dos importadores e das migrations. Quem é barrado é
--     a SESSÃO — inclusive a de um admin, porque a coluna não é campo de ficha.
--
-- (2) O DONO DA ETIQUETA. O sinal de "foi o sistema" é o próprio
--     `client_tag_by_system` mudar na MESMA escrita, e é o que
--     `fn_recalcular_cliente_do_contato` faz sempre: toda vez que ele mexe na
--     etiqueta, grava o dono junto. Mudou a presença sem o dono mudar → foi a
--     equipe (pela tela de Contatos, pela automação "adicionar tag", pela API),
--     e a etiqueta passa a ser dela. Com o dono já nulo não há o que
--     reconciliar, que é o caso da esmagadora maioria das edições de tag.
--
-- A CHAVE `deskcomm.cliente_pela_agenda` é de transação e não é alcançável de
-- fora: o PostgREST não envia SQL solto, e `set_config` mora em `pg_catalog`,
-- fora do schema exposto. Ela existe porque `auth.uid()` continua preenchido
-- dentro da `security definer` chamada pela sessão.
create or replace function public.fn_colunas_de_cliente_sao_do_sistema()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c_etiqueta constant text := 'cliente';
begin
  if auth.uid() is not null
     and coalesce(current_setting('deskcomm.cliente_pela_agenda', true), '') <> 'on'
     and (old.first_service_at is distinct from new.first_service_at
       or old.client_recognized_at is distinct from new.client_recognized_at
       or old.client_tag_by_system is distinct from new.client_tag_by_system) then
    raise exception 'colunas_de_cliente_sao_do_sistema' using errcode = '42501';
  end if;

  if new.client_tag_by_system is not null
     and old.client_tag_by_system is not distinct from new.client_tag_by_system
     and (c_etiqueta = any(coalesce(old.tags, '{}'::text[])))
         is distinct from (c_etiqueta = any(coalesce(new.tags, '{}'::text[]))) then
    new.client_tag_by_system := null;
  end if;

  return new;
end $$;

comment on function public.fn_colunas_de_cliente_sao_do_sistema() is
  'Guarda de contacts (migration 0262): sessão nenhuma grava first_service_at, client_recognized_at ou '
  'client_tag_by_system (42501 colunas_de_cliente_sao_do_sistema); o service role e as migrations passam. '
  'E quem mexe na etiqueta cliente sem gravar o dono na mesma escrita vira o dono dela, o que é como a '
  'remoção à mão passa a ser respeitada NA HORA. Provado em tests/invariants/cliente-nasce-do-agendamento.test.ts.';

-- Função de trigger não exige EXECUTE de quem dispara o UPDATE; revogar das
-- duas origens (o grant a PUBLIC e o grant direto a `anon` do baseline) não
-- quebra nada.
revoke execute on function public.fn_colunas_de_cliente_sao_do_sistema() from public, anon, authenticated;

-- `before update` sem lista de colunas, com a WHEN filtrando: a lista do
-- `update of` dispara quando a coluna é MENCIONADA na escrita, mesmo sem mudar
-- de valor — um `select *` que volta inteiro no UPDATE acordaria a guarda à toa.
-- A WHEN compara VALORES, e o caso comum (nenhuma das quatro mudou) nem chama a
-- função.
drop trigger if exists trg_contato_colunas_de_cliente on public.contacts;
create trigger trg_contato_colunas_de_cliente
  before update on public.contacts
  for each row
  when (old.first_service_at is distinct from new.first_service_at
     or old.client_recognized_at is distinct from new.client_recognized_at
     or old.client_tag_by_system is distinct from new.client_tag_by_system
     or old.tags is distinct from new.tags)
  execute function public.fn_colunas_de_cliente_sao_do_sistema();

-- ────────────────────────────────────────────────────────────────────────────
-- 5 · os triggers — condicionais ao interruptor, em INSERT, UPDATE e DELETE
-- ────────────────────────────────────────────────────────────────────────────
-- Os nomes são os do PR (`fn_marcar_contato_como_cliente`,
-- `trg_agendamento_marca_cliente`); o corpo é outro.
--
-- A SERIALIZAÇÃO COM QUEM LIGA A REGRA É UM ADVISORY LOCK DA ORGANIZAÇÃO, e não
-- uma trava de linha em `organizations`. O trigger toma a versão COMPARTILHADA
-- (não espera ninguém a não ser a ligação); `fn_definir_cliente_pela_agenda`
-- toma a EXCLUSIVA. Uma trava de linha (`for key share` aqui, `for update` lá)
-- serializaria o mesmo par, mas o `for update` na linha da organização barra
-- TODO insert com FK para ela enquanto o histórico é classificado — mensagem,
-- event_log, auditoria — e a trava compartilhada de linha escreve na tupla da
-- organização a cada alteração de agendamento, em toda organização, ligada ou
-- não. O advisory serializa só as duas partes que precisam.
create or replace function public.fn_marcar_contato_como_cliente()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_ligado boolean;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
  else
    v_org := new.organization_id;
  end if;

  -- Espera a ligação em voo commitar. O SELECT abaixo é outro comando, então
  -- em READ COMMITTED tira snapshot novo e enxerga a chave já gravada.
  perform pg_advisory_xact_lock_shared(hashtextextended(v_org::text, 262));

  -- Comparar com 'true'::jsonb nunca lança erro. Um `::boolean` abortaria a
  -- marcação do horário se alguém gravasse lixo na chave.
  select (o.settings -> 'crm' -> 'cliente_pela_agenda') = 'true'::jsonb
    into v_ligado
    from public.organizations o
   where o.id = v_org;

  if v_ligado is not true then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.fn_recalcular_cliente_do_contato(v_org, new.contact_id, true);
  elsif tg_op = 'UPDATE' then
    if new.contact_id is not null then
      -- O CONTATO DO HORÁRIO MUDOU — e a condição `is distinct from` tem DUAS
      -- causas, não uma. A primeira é o repontamento de `fn_mesclar_contatos`
      -- (X → Y): o horário só trocou de cadastro, e a escrita no vencedor não é
      -- a virada que as automações devem ver. A segunda é o PRIMEIRO vínculo de
      -- um horário que nasceu sem contato (null → Y), e esse é reconhecimento
      -- de verdade: é a primeira vez que este contato tem horário, e emite como
      -- um INSERT emitiria. Medido antes desta linha: no caminho null → Y o
      -- contato virava cliente, ganhava a etiqueta, ficava com
      -- `client_recognized_at` carimbado — e NENHUM `contact.tag_added` saía,
      -- nem ali nem nunca mais, porque o carimbo não volta a null.
      perform public.fn_recalcular_cliente_do_contato(
        v_org, new.contact_id,
        old.contact_id is not distinct from new.contact_id or old.contact_id is null);
    end if;
    if old.contact_id is not null and old.contact_id is distinct from new.contact_id then
      perform public.fn_recalcular_cliente_do_contato(v_org, old.contact_id, false);
    end if;
  else
    perform public.fn_recalcular_cliente_do_contato(v_org, old.contact_id, false);
  end if;

  return null;
end $$;

-- Função de trigger não exige EXECUTE de quem dispara o INSERT: revogar das
-- DUAS origens (o grant a PUBLIC e o grant direto a `anon` do ALTER DEFAULT
-- PRIVILEGES do baseline) não quebra nada.
revoke execute on function public.fn_marcar_contato_como_cliente() from public, anon, authenticated;

drop trigger if exists trg_agendamento_marca_cliente on public.calendar_appointments;
create trigger trg_agendamento_marca_cliente
  after insert on public.calendar_appointments
  for each row
  when (new.contact_id is not null)
  execute function public.fn_marcar_contato_como_cliente();

drop trigger if exists trg_agendamento_recalcula_cliente on public.calendar_appointments;
create trigger trg_agendamento_recalcula_cliente
  after update of status, starts_at, contact_id on public.calendar_appointments
  for each row
  when (old.status is distinct from new.status
        or old.starts_at is distinct from new.starts_at
        or old.contact_id is distinct from new.contact_id)
  execute function public.fn_marcar_contato_como_cliente();

-- Apagar o único horário que conta é o mesmo que cancelá-lo, para o contato.
-- `contact_id` é `on delete restrict`, então este trigger nunca vê a cascata de
-- um contato apagado; a de uma organização apagada chega aqui com a linha da
-- organização já invisível, e o interruptor lê desligado.
drop trigger if exists trg_agendamento_apagado_recalcula_cliente on public.calendar_appointments;
create trigger trg_agendamento_apagado_recalcula_cliente
  after delete on public.calendar_appointments
  for each row
  when (old.contact_id is not null)
  execute function public.fn_marcar_contato_como_cliente();

-- ────────────────────────────────────────────────────────────────────────────
-- 6 · ligar e desligar — e classificar o histórico ao ligar
-- ────────────────────────────────────────────────────────────────────────────
-- Chamada por app/actions/settings/definirClientePelaAgenda.ts com o client da
-- SESSÃO: `auth.uid()` é o que permite conferir papel aqui dentro. Nunca pelo
-- admin client, e nunca com `.from('organizations').update` — a única policy de
-- escrita da tabela é de platform admin, e o UPDATE de um admin de tenant casa
-- ZERO linhas e devolve sucesso.
--
-- PAPEL `admin`, e não `manager` como a vizinha `fn_agenda_settings`: aquela é
-- configuração reversível que não reescreve dado; ligar esta reescreve as
-- etiquetas de todo contato com histórico, e desligar não desfaz.
--
-- O HISTÓRICO É CLASSIFICADO SEM EVENTO. No estúdio medido pelo autor seriam
-- 630 `contact.tag_added` de uma vez, e uma regra "Quando um contato ganhar uma
-- tag" → enviar WhatsApp dispararia centenas de mensagens que ninguém pediu,
-- contra a doutrina de anti-banimento. O rastro é UMA linha de auditoria (na
-- action) com as contagens que esta função devolve.
--
-- DESLIGAR só grava `false`: nenhum contato muda, `first_service_at` fica
-- congelada e nenhuma TELA a mostra (o export de LGPD e a API de contatos
-- continuam levando o valor congelado, porque é dado guardado). RELIGAR recalcula todos — quem virou cliente
-- enquanto estava desligada ganha a etiqueta (sem evento: ao religar ele já era
-- cliente), quem ficou sem horário que conte perde a etiqueta que o sistema
-- tinha posto, e quem já tinha data não passa por virada. A etiqueta da equipe,
-- posta ou tirada à mão, não se mexe em nenhum dos três casos.
--
-- ⚠️ RELIGAR TIRA ETIQUETA, e a tela diz isso ANTES de confirmar
-- (components/agenda/ClientePelaAgenda.tsx) — `perderam_etiqueta` existe por isso.
create or replace function public.fn_definir_cliente_pela_agenda(p_org uuid, p_ligado boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_antes boolean;
  v_contato uuid;
  v_r text;
  v_ganharam integer := 0;
  v_perderam integer := 0;
begin
  if auth.uid() is null
     or p_org is null
     or p_ligado is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'cliente_pela_agenda_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'cliente_pela_agenda_mfa_required' using errcode = '42501';
  end if;

  -- EXCLUSIVA, ANTES de ler qualquer coisa: espera todo INSERT/UPDATE de
  -- agendamento desta organização que já passou pelo trigger (e segura a
  -- compartilhada até commitar), e faz os seguintes esperarem esta transação.
  -- Os comandos abaixo tiram snapshot novo e enxergam o que já commitou.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 262));

  -- Sem `for update` na linha da organização: a exclusiva acima já serializa
  -- esta função consigo mesma e com o trigger, e a trava de linha barraria todo
  -- insert com FK para a organização durante o laço. O UPDATE abaixo toma só a
  -- trava que não conflita com essas FKs.
  select o.settings into v_settings
    from public.organizations o
   where o.id = p_org;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;
  v_antes := (v_settings -> 'crm' -> 'cliente_pela_agenda') = 'true'::jsonb;

  -- Mescla dentro de `crm`: o que mais morar ali (hoje nada) não é apagado, e
  -- um `crm` que não seja objeto é substituído em vez de abortar.
  update public.organizations
     set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{crm}',
           (case when jsonb_typeof(settings -> 'crm') = 'object' then settings -> 'crm' else '{}'::jsonb end)
             || jsonb_build_object('cliente_pela_agenda', p_ligado),
           true)
   where id = p_org;

  -- O histórico, SÓ na virada desligado → ligado, SÓ desta organização.
  if p_ligado and v_antes is not true then
    for v_contato in
      select c.id
        from public.contacts c
       where c.organization_id = p_org
         and c.is_anonymized = false
         and c.is_merged_into is null
         and (c.first_service_at is not null
              or exists (select 1 from public.calendar_appointments a
                          where a.organization_id = p_org and a.contact_id = c.id))
       order by c.id
    loop
      v_r := public.fn_recalcular_cliente_do_contato(p_org, v_contato, false);
      if v_r = 'etiquetado' then
        v_ganharam := v_ganharam + 1;
      elsif v_r = 'desetiquetado' then
        v_perderam := v_perderam + 1;
      end if;
    end loop;
  end if;

  -- O QUARTO NÚMERO EXISTE PARA A TELA NÃO MENTIR. Medido: numa organização
  -- cujo único contato TEM horário marcado, todos cancelados, o corpo era
  -- `{ganharam: 0, perderam: 0, clientes: 0}` — e a última frase de
  -- `components/agenda/ClientePelaAgenda.tsx` dizia "Nenhum contato tinha
  -- horário marcado ainda". Numa clínica com cancelamentos, que é o nicho que
  -- esta migration cita, essa é a primeira frase depois de ligar. Zero
  -- etiquetas novas tem QUATRO causas, e esta é a única que os outros três
  -- números não distinguem.
  return jsonb_build_object(
    'ligado', p_ligado,
    'mudou', coalesce(v_antes, false) <> p_ligado,
    'ganharam_etiqueta', v_ganharam,
    'perderam_etiqueta', v_perderam,
    'clientes', (select count(*) from public.contacts
                  where organization_id = p_org and first_service_at is not null
                    and is_anonymized = false and is_merged_into is null),
    'com_agendamento_que_nao_conta', (
      select count(*) from public.contacts c
       where c.organization_id = p_org
         and c.first_service_at is null
         and c.is_anonymized = false and c.is_merged_into is null
         and exists (select 1 from public.calendar_appointments a
                      where a.organization_id = p_org and a.contact_id = c.id))
  );
end $$;

revoke execute on function public.fn_definir_cliente_pela_agenda(uuid, boolean) from public, anon;
grant  execute on function public.fn_definir_cliente_pela_agenda(uuid, boolean) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7 · a junção de contatos pega a trava da organização primeiro
-- ────────────────────────────────────────────────────────────────────────────
-- Cópia de `fn_mesclar_contatos` como está em vigor (migration 0222, a última a
-- redefini-la), com UMA mudança: a linha do `pg_advisory_xact_lock_shared` antes
-- do mutex dos atendimentos. O porquê está no comentário ao lado dela.
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
      join pg_catalog.pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and array_length(co.conkey, 1) = 1
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


revoke execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
