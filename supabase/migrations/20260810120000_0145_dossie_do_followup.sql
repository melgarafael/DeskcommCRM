-- 0145 — o dossiê do follow-up: o tempo que a IA escolheu, e a pausa que uma pessoa manda dar.
--
-- A fila mostrava QUE existe um follow-up e não mostrava NADA do que já
-- aconteceu nele — `followup_enrollment_events` grava cada passo do motor desde
-- a 0054 e nenhuma tela lia a tabela. E a única intervenção possível era
-- cancelar, que é porta de saída, não intervenção: quem quisesse segurar o
-- fluxo por dois dias tinha de matá-lo e perder a caminhada.
--
-- Três mudanças, nenhuma delas destrutiva:
--
--   1. `timing_plan` — o plano de atrasos que o agente decide UMA VEZ, ao
--      acionar o follow-up (contrato fechado com o dono do motor, migration
--      0144). Criado aqui com `if not exists` de propósito: o consumidor (o
--      dossiê) não pode depender da ORDEM em que as duas migrations chegam ao
--      banco de um clone, e uma coluna que falta vira `42703` na rota — a
--      tela inteira quebra por causa de um SELECT.
--
--   2. `paused_manual` — o estado que faltava. `paused_handoff` já existe e
--      significa outra coisa ("um humano assumiu a conversa"), e quem o retoma é
--      o `reactToHandoffClose` quando o handoff fecha; usar aquele estado para a
--      pausa manual faria o sistema retomar sozinho um follow-up que uma pessoa
--      mandou parar, na primeira vez que qualquer handoff daquele contato
--      fechasse.
--
--   3. o índice de unicidade do "vivo" passa a contar a pausa manual. Sem isso,
--      um enrollment pausado deixaria de ocupar a vaga do par
--      (organization_id, contact_id) e um segundo nasceria vivo ao lado — dois
--      follow-ups sobre a mesma pessoa no instante em que o primeiro fosse
--      retomado. As COLUNAS do índice não são as da DDL original; ver o aviso
--      no bloco 3.
--
-- Nenhuma linha existente viola o que se cria aqui: o CHECK novo só ACRESCENTA
-- um valor ao conjunto aceito, e o predicado novo do índice cobre exatamente as
-- mesmas linhas que o antigo cobria (nenhum banco tem `paused_manual` antes
-- desta migration). Por isso não há passo de deduplicação — a doutrina o exige
-- quando a constraint aperta, e esta afrouxa.

-- ---------------------------------------------------------------------------
-- 1 · o plano de tempo decidido pelo agente
-- ---------------------------------------------------------------------------

alter table public.followup_enrollments
  add column if not exists timing_plan jsonb;

comment on column public.followup_enrollments.timing_plan is
  'Plano de atrasos decidido pelo agente no acionamento do follow-up (migration 0144). '
  'Forma: {"decidido_em":ISO,"modelo":texto,"esperas":{"<node_id>":{"escolhido_ms":int,'
  '"min_ms":int,"max_ms":int,"clampado":bool,"motivo":texto}}}. NULL = fluxo v1 ou espera '
  'fixa: o dossiê não mostra o bloco em vez de inventar valor.';

-- ---------------------------------------------------------------------------
-- 2 · a pausa que uma pessoa manda dar
-- ---------------------------------------------------------------------------

-- Os dois CHECKs saem pelo CATÁLOGO, não pelo nome: no banco nascido do
-- `create table` deste repo eles são anônimos (`..._status_check` e `..._check`,
-- nomes que o Postgres gera), e um clone que já tenha passado por um dump/restore
-- pode carregar outro nome. Dropar por nome fixo falharia em silêncio — o `if
-- exists` não acha nada, o `add constraint` abaixo tropeça no duplicado, o
-- `exception when duplicate_object` engole, e o banco fica com o CHECK ANTIGO
-- recusando `paused_manual` num INSERT que a aplicação considera válido.
-- O filtro é a própria semântica: constraint que fala de `paused_handoff` e
-- ainda não conhece `paused_manual` é, por construção, uma das duas.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'followup_enrollments'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%paused_handoff%'
       and pg_get_constraintdef(con.oid) not like '%paused_manual%'
  loop
    execute format('alter table public.followup_enrollments drop constraint %I', c.conname);
  end loop;
end $$;

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_status_valido
    check (status in ('active','waiting_reply','paused_handoff','paused_manual','completed','cancelled','dead'));
exception when duplicate_object then null; end $$;

-- Estados com relógio TÊM `next_eval_at`; pausados/terminais NÃO. A pausa manual
-- entra na segunda perna: pausar é justamente tirar o enrollment do relógio, e é
-- por isso que `fn_claim_due_followup_enrollments` deixa de enxergá-lo sem que
-- ela precise mudar (o claim filtra `status in ('active','waiting_reply')`).
do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_relogio_coerente
    check (
      (status in ('active','waiting_reply') and next_eval_at is not null)
      or (status in ('paused_handoff','paused_manual','completed','cancelled','dead'))
    );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3 · pausado continua ocupando a vaga do "vivo"
-- ---------------------------------------------------------------------------

-- ⚠️ AS COLUNAS SÃO (organization_id, contact_id), NÃO (pointer_id, contact_id).
--
-- A DDL original deste índice (o `create table` lá em cima) usa `pointer_id`, e
-- uma migration posterior o RECRIOU por organização — "um follow-up vivo por
-- CONTATO na organização", com backfill cancelando os excedentes. Quem precisa
-- mexer só no PREDICADO (como aqui, para incluir `paused_manual`) tem de copiar
-- a definição EM VIGOR, nunca a original: recriar a partir da linha errada
-- reverte a garantia sem conflito de merge, sem erro de aplicação e sem sintoma
-- imediato — o mesmo contato voltaria a poder ter um follow-up vivo em cada
-- fluxo. Foi o que este arquivo fez antes desta correção; pego na integração.
drop index if exists idx_followup_enrollments_one_live;
create unique index if not exists idx_followup_enrollments_one_live
  on public.followup_enrollments (organization_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff','paused_manual');

-- ---------------------------------------------------------------------------
-- 4 · o dossiê lê a história em ordem
-- ---------------------------------------------------------------------------

-- A leitura do dossiê é `where enrollment_id = $1 order by created_at` — o
-- índice único que já existia é PARCIAL (só linhas com idempotency_key) e serve
-- ao dedup do motor, não a esta varredura.
create index if not exists idx_followup_events_enrollment_tempo
  on public.followup_enrollment_events (enrollment_id, created_at);
