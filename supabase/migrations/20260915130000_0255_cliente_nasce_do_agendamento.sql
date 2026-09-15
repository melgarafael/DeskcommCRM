-- 0255 — o contato vira CLIENTE quando tem hora marcada
--
-- O PROBLEMA, medido: `lib/leads/nascimento-do-lead.ts` abre um lead no funil
-- `is_default` para TODO número que escreve. Num estúdio com 630 contatos e a
-- agenda inteira migrada, quem é cliente há anos entra no funil de captação a
-- cada "oi" — e o funil de entrada deixa de significar "gente nova". Não havia
-- coluna, flag ou tag que registrasse a diferença, então nem a tela nem o
-- agente de IA tinham como saber com quem estavam falando.
--
-- O GATILHO É O AGENDAMENTO, NÃO O COMPARECIMENTO. Decisão do dono do produto:
-- combinar hora já é relação estabelecida. Comanda/venda fica para quando o
-- módulo financeiro existir; `calendar_appointments` é o que existe hoje.
--
-- POR QUE TRIGGER E NÃO CÓDIGO NO HANDLER. Hoje `marcarAgendamentoHandler` é o
-- único INSERT — UI, MCP e rota HTTP convergem nele. "Hoje" é afirmação de
-- estado: o espelho do Google já tem colunas nesta tabela e vai inserir um dia.
-- Regra no chamador é regra que o próximo chamador não herda; no schema, herda.
-- Mesmo desenho de `fn_update_last_activity_at` (0079): AFTER INSERT na filha,
-- update monotônico no pai, nenhuma rede dentro da transação.
--
-- POR QUE AS DUAS MARCAS, E QUAL DELAS MANDA. `first_service_at` é a VERDADE:
-- é ela que decide o funil, e é lida na linha de `contacts` que o nascimento do
-- lead JÁ carrega (sem ela, todo inbound pagaria uma consulta a mais na agenda).
-- A tag `cliente` é a ETIQUETA DE TRABALHO: filtro da lista de Contatos, badges
-- e contexto do agente já existem e passam a mostrá-la sem código novo.
-- A tag pode divergir da coluna, numa direção só e de propósito: um humano
-- remove a tag e isso é legítimo — mas o selo da tela e a escolha do funil leem
-- a COLUNA, então ninguém volta a ser lead por um descuido no PATCH de contatos
-- (que substitui `tags` por inteiro).

-- ────────────────────────────────────────────────────────────────────────────
-- 1 · o fato, no contato
-- ────────────────────────────────────────────────────────────────────────────
alter table public.contacts
  add column if not exists first_service_at timestamptz;

comment on column public.contacts.first_service_at is
  'Primeiro atendimento MARCADO (min(calendar_appointments.starts_at)). FONTE DA '
  'VERDADE de "e cliente" — a tag cliente e projecao, removivel a mao. Monotonica: '
  'cancelar agendamento NAO desfaz (a regua e ter combinado hora), e a data so anda '
  'para tras (least), para que registrar atendimento antigo corrija em vez de ser '
  'ignorado. PRESERVADA na anonimizacao: que houve atendimento e quando e registro '
  'de operacao, nao dado da pessoa — mesmo criterio de crm_tasks.due_date.';

create index if not exists contacts_clientes_idx
  on public.contacts (organization_id, first_service_at desc)
  where first_service_at is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2 · onde o cliente que volta a escrever entra
-- ────────────────────────────────────────────────────────────────────────────
-- ⚠️ COLUNA, E NÃO CHAVE EM `settings`. O jsonb do funil guarda CONTEÚDO de
-- configuração (fields, canonical_tags, lost_reasons); papel do funil dentro da
-- organização já mora em coluna (`is_default`, `is_archived`). Misturar seria o
-- anti-pattern 6 — a UI lendo path direto de jsonb —, e em `settings` não há
-- constraint possível: a exclusividade viraria código de aplicação que alguém
-- esquece de chamar. Com índice único, quem cobra é o banco.
alter table public.crm_pipelines
  add column if not exists is_client_pipeline boolean not null default false;

comment on column public.crm_pipelines.is_client_pipeline is
  'Onde nasce o negocio de quem JA e cliente (contacts.first_service_at nao nulo). '
  'Espelha is_default: booleano, exclusivo por organizacao, com tela em /app/kanban. '
  'Nenhum nome de funil aparece em codigo. Ausente e estado VALIDO, e e o de toda '
  'instalacao nova: sem funil marcado, o cliente nasce no funil padrao — que e o '
  'comportamento anterior. Um mesmo funil pode ser padrao E de clientes: e o caso '
  'da organizacao que tem um funil so.';

-- Cópia literal da forma de `uniq_crm_pipelines_org_default`, que é
-- `where (is_default = true)` — SEM recorte de arquivado, ao contrário do que o
-- comentário de lib/pipelines/pipeline-editing.ts afirmava. Divergir da forma do
-- irmão criaria dois comportamentos para o mesmo gesto na mesma tela.
create unique index if not exists uniq_crm_pipelines_org_client
  on public.crm_pipelines (organization_id) where (is_client_pipeline = true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3 · o carimbo
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_marcar_contato_como_cliente()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- `least` é o `greatest` de fn_update_last_activity_at no sentido oposto: lá o
  -- relógio é "a última vez", aqui é "a primeira". Um agendamento inserido fora
  -- de ordem (importação, sync do Google) corrige a data para trás em vez de ser
  -- ignorado — e é isso que faz trigger e backfill conviverem sem que a ordem de
  -- aplicação importe.
  --
  -- O PREDICADO FINAL É O QUE TORNA ISTO BARATO. No caso comum (cliente antigo
  -- marcando a enésima hora) NENHUMA linha é atualizada: `updated_at` não se
  -- move e o contato não vira ruído de realtime a cada agendamento.
  --
  -- `is_anonymized = false`: contato anonimizado não recebe escrita derivada
  -- nova. Sem esta guarda, um agendamento posterior faria "Contato Anonimizado
  -- #3f2a" reaparecer etiquetado — anonimização parcial silenciosa, que é
  -- exatamente o modo de falha que a cascata de LGPD existe para impedir.
  update public.contacts c
     set first_service_at = least(coalesce(c.first_service_at, 'infinity'::timestamptz), new.starts_at),
         -- `array_append` e NÃO `c.tags || ...`: sem cast, o `||` lê o literal
         -- como ARRAY e o baseline morre em `malformed array literal: "cliente"`.
         -- Medido no CI, no modo INSTALL — é o tipo de erro que só um Postgres
         -- real acusa, e por isso o `test:db` não é opcional em mudança de schema.
         tags = case when 'cliente' = any(c.tags) then c.tags else array_append(c.tags, 'cliente') end,
         updated_at = now()
   where c.id = new.contact_id
     -- Tenancy explícita mesmo com a FK: é a convenção do repo, e é a rede que
     -- sobra se um dia alguém inserir linha com contato de outra organização.
     and c.organization_id = new.organization_id
     and c.is_anonymized = false
     and (c.first_service_at is null
          or c.first_service_at > new.starts_at
          or not ('cliente' = any(c.tags)));
  return new;
end$$;

-- Função de trigger não exige EXECUTE de quem dispara o INSERT: revogar das DUAS
-- origens (o grant a PUBLIC que o Postgres dá a toda função ao criá-la, e o
-- grant a `anon` do ALTER DEFAULT PRIVILEGES do baseline, que vale para todo
-- apêndice novo) não quebra nada, e mantém a função fora da lista de exceções de
-- tests/invariants/hardening-definer-varredura.test.ts.
revoke execute on function public.fn_marcar_contato_como_cliente() from public, anon, authenticated;
grant  execute on function public.fn_marcar_contato_como_cliente() to service_role;

drop trigger if exists trg_agendamento_marca_cliente on public.calendar_appointments;
create trigger trg_agendamento_marca_cliente
  after insert on public.calendar_appointments
  for each row
  when (new.contact_id is not null)
  execute function public.fn_marcar_contato_como_cliente();

-- ────────────────────────────────────────────────────────────────────────────
-- 4 · backfill — quem JÁ tem histórico
-- ────────────────────────────────────────────────────────────────────────────
-- Genérico (nenhum id de tenant), e a guarda `first_service_at is null` é o que
-- o torna idempotente SEM ser repetitivo: o `update.sh` re-aplica o baseline a
-- cada atualização do produto, e sem ela devolveria, a cada versão, a tag que um
-- humano removeu de propósito.
--
-- TODO STATUS ENTRA, `cancelled` inclusive — a mesma régua do trigger. Duas
-- réguas para o mesmo fato divergem no primeiro conserto.
with primeiro as (
  select organization_id, contact_id, min(starts_at) as em
    from public.calendar_appointments
   where contact_id is not null
   group by organization_id, contact_id
)
update public.contacts c
   set first_service_at = p.em,
       tags = case when 'cliente' = any(c.tags) then c.tags else array_append(c.tags, 'cliente') end
  from primeiro p
 where p.organization_id = c.organization_id
   and p.contact_id = c.id
   and c.is_anonymized = false
   and c.first_service_at is null;
