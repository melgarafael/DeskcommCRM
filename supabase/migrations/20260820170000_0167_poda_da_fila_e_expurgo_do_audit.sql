-- 0167 — A FILA E A AUDITORIA GANHAM PODA. O QUE TEM DONO NÃO SAI.
--
-- ═══ O DEFEITO MEDIDO (issue #261) ═══
--
--     $ grep -rn "from job_queue" lib workers app supabase scripts | grep -i delete
--     (zero linhas)
--
-- Nada no produto apaga job terminal. `job_queue` cresce desde a instalação e
-- nunca encolhe. `api_audit_log` tem retenção de 5 anos no `COMMENT ON TABLE` e
-- em seis documentos — e nenhum código a executava: nem expurgo, nem "cold
-- storage S3" (auditoria de 2026-08-14: zero ocorrência de arquivamento).
--
-- Duas contas do cliente pagam por isso. **Espaço**: o plano free do Supabase
-- limita 500 MB de banco, e estas duas são as candidatas naturais a estourar
-- antes de qualquer tabela de negócio. **CPU**: o bloat degrada o `count(*)` do
-- claim — 715 buffers varridos numa tabela com ZERO linhas vivas, medido na #260.
--
-- ═══ POR QUE DELETE POR IDADE, E NÃO PARTICIONAMENTO ═══
--
-- Particionar `job_queue` por data exigiria mexer no caminho de escrita mais
-- quente do produto (o claim `FOR UPDATE SKIP LOCKED` com índice parcial e dois
-- índices ÚNICOS parciais — `uniq_job_queue_one_running_per_contact` e
-- `uniq_job_queue_source_event`, que numa tabela particionada precisariam
-- incluir a chave de partição para existir). Trocar a garantia de exatamente-um-
-- turno-por-lead por espaço em disco é um péssimo negócio. DELETE em lotes
-- resolve o problema declarado sem tocar em nada do claim.
--
-- ═══ O QUE TEM DONO NÃO SAI — TRÊS CORTES, NÃO UM ═══
--
-- (1) `pending` e `running` NUNCA saem. `pending` é trabalho que ainda vai sair
--     (o worker o reclama pelo relógio da fila); `running` está com um worker
--     agora, e se ele morrer o reaper o devolve pelo visibility timeout. Apagar
--     qualquer um dos dois PERDE trabalho. Terminais são só três, conferidos em
--     `lib/agent-engine/queue/queue.ts`: `done` (completeJob), `failed`
--     (cancelJob — veto permanente de negócio) e `dead` (esgotou max_attempts).
--
-- (2) `dead` com AVISO ABERTO na Central também tem dono — um humano que ainda
--     não olhou. `failJob`/`reapExpiredJobs` abrem `agent_inbox_items` com
--     `ref_kind='job_queue'` e `ref_id = job.id`; apagar o job deixaria o aviso
--     apontando para o vazio. O filtro `not exists` fica DENTRO do `where`, ANTES
--     do `limit`, e isso é load-bearing: filtrar depois do limite faria um lote
--     inteiro de jobs protegidos devolver 0, o laço do cron pararia achando que
--     acabou, e a poda morreria de fome com backlog na frente.
--
-- (3) O corte é por `created_at`, nunca por `locked_at`/`run_after` — as duas
--     colunas que outro código reescreve (mesma lição do recover-stuck-messages:
--     medir idade por coluna que alguém atualiza faz a linha rejuvenescer).
--
-- ═══ O EFEITO EM CASCATA, DECLARADO (não é surpresa, é escolha) ═══
--
-- Apagar um job leva junto, por FK `on delete cascade`, as linhas de
-- `send_ledger` (unique (job_id, seq)) e `before_send_traces` daquele run — as
-- duas também crescem monotonicamente, então isso é parte do conserto, não um
-- dano colateral. `llm_calls`, `lead_checkpoints` e `lead_state_transitions` são
-- `on delete set null`: o histórico de custo e de funil FICA, só perde o
-- ponteiro para o run.
--
-- Os DOIS consumidores de `send_ledger` sem janela de tempo foram medidos, e os
-- dois falham FECHADO quando a linha some:
--   - `countPriorAcceptedSends` = 0 ⇒ "1º outbound" ⇒ o disclosure de IA volta a
--     ser enviado (mais transparência, nunca menos);
--   - o mesmo sinal alimenta o gate LGPD, que VETA 1º toque de prospecção sem
--     base legal válida (before-send.ts:261) — vetar a mais, nunca a menos.
-- `health/circuit.ts` já é janelado (`windowMs`, default 6 h), muito abaixo de
-- qualquer retenção admissível aqui. Por isso o piso da função é de 7 dias e o
-- default é 90: nenhum dos dois consumidores muda de veredito nesse horizonte.
--
-- ═══ AUDITORIA: POR QUE UMA SECURITY DEFINER, E POR QUE ISSO NÃO É UMA PORTA ═══
--
-- `api_audit_log` é append-only NO SCHEMA, não só na prosa: o baseline concede
-- `SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE, MAINTAIN` a anon,
-- authenticated E service_role — DELETE e UPDATE não estão lá para ninguém.
-- Logo o expurgo NÃO pode sair pelo admin client; ele precisa de uma função que
-- rode como o dono da tabela. Cinco razões pelas quais esta função não vira uma
-- porta de adulteração de auditoria, e cada uma é conferível:
--
--   (a) ELA NÃO TEM SELETOR DE LINHA. Nenhum parâmetro de organização, ator,
--       ação, recurso, id ou limite superior de data. O único predicado é
--       `created_at < now() - N dias`: ela só sabe apagar pela ponta MAIS VELHA.
--       Não existe argumento que a faça apagar a linha de ontem que incomoda.
--   (b) O PISO MORA DENTRO DA FUNÇÃO, não em quem chama. `greatest(..., 90)`:
--       mesmo quem tem a service key e chame com `p_retencao_dias => 0` não
--       remove nada com menos de 90 dias. O knob só escolhe o quanto ALÉM do
--       piso, nunca aquém.
--   (c) NÃO É ALCANÇÁVEL PELA REST. `revoke` das duas origens de EXECUTE (o
--       grant direto a anon do `ALTER DEFAULT PRIVILEGES` do baseline, e o grant
--       a PUBLIC que o Postgres dá na criação) + grant só a `service_role`.
--   (d) ELA NÃO AMPLIA O RAIO DE QUEM JÁ TEM A CHAVE. Quem chama já é
--       service_role — que no self-host tem `TRUNCATE` nesta mesma tabela e o
--       dono do banco na mão. A função não abre poder novo; ela dá FORMA
--       auditável ao poder que já existia, e é a forma mais estreita possível.
--   (e) ELA REGISTRA A PRÓPRIA EROSÃO. O cron `data-retention` grava
--       `retention.sweep_run` com a contagem apagada — e essa linha, por ser
--       nova, é justamente a que a próxima chamada não alcança. A trilha guarda
--       quem a encurtou.
--
-- Hot 90 dias / cold em S3 NÃO é entregue aqui, e a doutrina do `CLAUDE.md` foi
-- corrigida em vez de fingir: um produto self-host não tem para onde arquivar
-- (o Supabase Storage do cliente é a MESMA cota, 1 GB, já dividida com
-- `whatsapp-media`, que também não tem poda). O que se entrega é o expurgo na
-- fronteira da retenção, que é a metade que o cliente pode executar sozinho.
--
-- Idempotente: `create or replace` + `create index if not exists` + `revoke`
-- (no-op quando o privilégio já não existe). Nenhuma constraint nova, então não
-- há dado a deduplicar antes.

-- Índice de poda. Sem ele o DELETE por idade vira seq scan diário sobre a tabela
-- inteira — trocaria a conta de disco pela de CPU, que é o outro lado da issue.
-- Parcial nos três status terminais: é exatamente o conjunto que a poda visita.
create index if not exists idx_job_queue_poda
  on public.job_queue (created_at)
  where status in ('done', 'failed', 'dead');

-- O `api_audit_log` tem cinco índices e nenhum começa por `created_at`, então
-- `where created_at < corte` não tinha por onde entrar. Nome próprio da poda de
-- propósito: `create index if not exists` casa por NOME, e um nome genérico como
-- `idx_audit_created_at` poderia existir num clone com outra definição e virar
-- no-op silencioso.
create index if not exists idx_audit_expurgo_created_at
  on public.api_audit_log (created_at);

-- Acelera o corte (2): o anti-join contra os avisos ABERTOS que apontam para um
-- job. `idx_agent_inbox_items_open` é por (organization_id, created_at) e não
-- serve para procurar por `ref_id`.
create index if not exists idx_agent_inbox_items_ref_aberto
  on public.agent_inbox_items (ref_kind, ref_id)
  where status = 'open';

create or replace function public.fn_podar_fila_de_jobs(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Piso de 7 dias: abaixo disso a cascata em `send_ledger` começaria a mexer no
  -- horizonte em que "1º outbound" ainda significa alguma coisa para um lead vivo.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagados int;
begin
  with candidatos as (
    select j.id
      from public.job_queue j
     where j.status in ('done', 'failed', 'dead')
       and j.created_at < now() - make_interval(days => v_dias)
       -- ANTES do limit, sempre. Ver corte (2) no cabeçalho.
       and not exists (
         select 1
           from public.agent_inbox_items i
          where i.ref_kind = 'job_queue'
            and i.ref_id = j.id
            and i.status = 'open'
       )
     order by j.created_at
     limit v_limite
  )
  delete from public.job_queue j
   using candidatos c
   where j.id = c.id;
  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

create or replace function public.fn_expurgar_auditoria_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 1825 dias = os 5 anos da regra L-10. O piso de 90 é o que impede que o knob
  -- vire apagador de rastro recente — ver (b) no cabeçalho.
  v_dias int := greatest(coalesce(p_retencao_dias, 1825), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select a.id
      from public.api_audit_log a
     where a.created_at < now() - make_interval(days => v_dias)
     order by a.created_at
     limit v_limite
  )
  delete from public.api_audit_log a
   using vencidas v
   where a.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

-- As DUAS origens de EXECUTE, em ambas as funções (doutrina de migrations, item
-- 9): `revoke from public` não tira o grant DIRETO que o `ALTER DEFAULT
-- PRIVILEGES ... TO anon` do baseline dá a toda função nova; `revoke from anon`
-- não tira o grant a PUBLIC que o Postgres dá na criação. `authenticated` entra
-- porque nenhuma tela chama estas funções com a sessão do usuário — grant ali
-- seria superfície morta.
revoke execute on function public.fn_podar_fila_de_jobs(int, int)
  from public, anon, authenticated;
grant execute on function public.fn_podar_fila_de_jobs(int, int) to service_role;

revoke execute on function public.fn_expurgar_auditoria_vencida(int, int)
  from public, anon, authenticated;
grant execute on function public.fn_expurgar_auditoria_vencida(int, int) to service_role;

-- O COMMENT da tabela afirmava um mundo que nunca existiu ("Retencao 5 anos",
-- sem nada que a executasse). Passa a dizer o que o schema de fato faz, e a
-- apontar para quem faz — afirmação de estado que envelhece vira ponteiro.
comment on table public.api_audit_log is
  'L-10: append-only (sem GRANT de UPDATE/DELETE a ninguém). Retenção default 5 anos, '
  'expurgada por public.fn_expurgar_auditoria_vencida (piso de 90 dias) a partir do cron '
  'app/api/v1/cron/data-retention. Não há camada cold/S3.';

notify pgrst, 'reload schema';
