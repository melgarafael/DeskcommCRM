-- 0143: o agendamento do follow-up passa a nascer do relógio do BANCO
--
-- ═══ O DEFEITO ═══
--
-- Quem AGENDA gravava `next_eval_at` com o relógio do PROCESSO
-- (`new Date()` em Node); quem RECLAMA compara com `now()` do POSTGRES
-- (`fn_claim_due_followup_enrollments`: `and next_eval_at <= now()`). Medido
-- nesta máquina, em 12 amostras, o banco fica de 17 a 34 ms ATRÁS do processo.
--
-- Consequência: o instante que o processo chama de "agora" ainda é FUTURO para
-- o claim. O tick seguinte não reclama o enrollment, e ele espera o tick DEPOIS
-- — até 60 segundos, porque o cron bate de minuto em minuto.
--
-- Onde isso dói mais: `lib/followup/reactivity.ts` marca "acorde agora" quando
-- o LEAD RESPONDE. Um minuto de silêncio depois de a pessoa falar com a gente,
-- num sistema cujo propósito é justamente não deixar ninguém esperando. Nos
-- outros dois casos (`gatilho-etapa.ts`, `silence-sweep.ts`) o efeito é o
-- follow-up NASCER e perder o primeiro tick — mesmo mecanismo, custo menor,
-- porque ali não há ninguém aguardando resposta.
--
-- ═══ POR QUE NÃO SE CORRIGE COM MARGEM ═══
--
-- Subtrair alguns milissegundos do relógio do processo "resolveria" hoje e
-- envelheceria: a margem certa depende da máquina, da carga e da distância até
-- o banco. Número mágico calibrado num ambiente é defeito adormecido em outro.
-- Afrouxar o claim para tolerar futuro próximo seria pior ainda — relaxaria a
-- condição para TODO agendamento, inclusive os legítimos no futuro.
--
-- A correção é fazer os dois lados da comparação usarem O MESMO RELÓGIO.
--
-- ═══ DUAS FERRAMENTAS, PORQUE SÃO DOIS CASOS ═══
--
-- 1. NASCIMENTO (INSERT) — `next_eval_at` ganha `default now()`. Quem insere um
--    enrollment que já vence agora simplesmente OMITE a coluna, e o instante
--    nasce do relógio do banco: zero round-trip, zero desvio, e nada para
--    chamar errado. Aditivo e retrocompatível — `default` só age na AUSÊNCIA da
--    coluna, então todo insert que hoje passa valor explícito continua
--    exatamente como está.
--
-- 2. RETOMADA (UPDATE) — `default` não alcança um UPDATE, e o `supabase-js`
--    grava VALOR, nunca EXPRESSÃO: `update ... set next_eval_at = now()` não é
--    exprimível pelo client. Daí `fn_agora()`, que o worker chama por RPC para
--    ler o relógio do banco antes de escrever. Um round-trip, e só nos eventos
--    que de fato acordam alguém.
--
-- ═══ O QUE O DEFAULT CUSTA, DECIDIDO E NÃO DESCOBERTO DEPOIS ═══
--
-- Hoje, inserir um enrollment ativo SEM `next_eval_at` falha ALTO: o CHECK
-- `(status in ('active','waiting_reply') and next_eval_at is not null)` recusa a
-- linha. Com o default, esquecer o campo passa a ser SILENCIOSO — a linha entra
-- e significa "vencido agora".
--
-- Estamos trocando uma falha barulhenta por uma plausível, e isso é uma
-- decisão, não um efeito colateral. Para os DOIS produtores de nascimento é
-- exatamente o que se quer: eles significam "agora", e o default é o caminho
-- mais curto entre a intenção e o relógio certo. Para um insert que deveria
-- agendar para daqui a dias, esquecer o campo deixa de ser recusado e passa a
-- disparar imediatamente.
--
-- O custo é pequeno e aceito porque quem quiser OUTRO instante continua
-- passando valor explícito, e porque a regra está escrita no `comment on
-- column` abaixo — quem for escrever o próximo insert lê a coluna, não esta
-- migration. A guarda `tests/invariants/followup-agendamento-do-banco.test.ts`
-- cobre o outro lado: reprova quem agendar "para agora" com o relógio do
-- processo, por qualquer dos dois caminhos.
--
-- Idempotente: `alter column ... set default` e `create or replace function`
-- podem ser reaplicados sem efeito duplicado (o `update.sh` do clone reaplica o
-- baseline inteiro por contrato).

alter table public.followup_enrollments
  alter column next_eval_at set default now();

comment on column public.followup_enrollments.next_eval_at is
  'Quando este enrollment vence. DEFAULT now() do BANCO (migration 0147): quem agenda "para agora" deve OMITIR a coluna, porque o claim compara com now() do Postgres e o relógio do processo fica milissegundos à frente — o suficiente para o enrollment perder um tick inteiro (60s). Agendamento para o FUTURO continua passando valor explícito.';

-- Lê o relógio do banco. `stable` e não `volatile`: dentro de UMA instrução o
-- valor não precisa mudar, e `now()` já é o início da transação — o contrato é
-- "o relógio que o claim usa", não "o instante mais preciso possível".
create or replace function public.fn_agora()
returns timestamptz
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select now()
$$;

comment on function public.fn_agora() is
  'O relógio do BANCO, para quem precisa gravar um instante que será comparado com now() (migration 0147). Existe porque o PostgREST só expõe tabela e função: o supabase-js não sabe fazer "select now()", e sem isto o worker agendaria com o relógio do próprio processo — que fica à frente do banco e faz o enrollment perder um tick.';

-- ⚠️ AS DUAS ORIGENS DE EXECUTE, e tratar só uma deixa a função exposta com o
-- gate verde (CLAUDE.md, doutrina de migrations, item 9):
--   (A) o `alter default privileges ... grant all on functions to anon` do
--       baseline, que vale para toda função criada DEPOIS dele — isto é, para
--       todo apêndice novo — e que `revoke from public` NÃO remove;
--   (B) o grant a PUBLIC que o Postgres dá a qualquer função ao criá-la, que
--       `revoke from anon` NÃO remove.
-- Sem os dois, o PostgREST expõe isto como RPC alcançável pela anon key, que
-- vai para o browser.
revoke all     on function public.fn_agora() from public;
revoke execute on function public.fn_agora() from anon, authenticated;
grant  execute on function public.fn_agora() to service_role;
