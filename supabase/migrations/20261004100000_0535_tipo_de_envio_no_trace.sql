-- manifest: **O `before_send_traces` grava se a tentativa era RESPOSTA ou DISPARO (#2112, seguimento do #2031/#1985).** A cadeia já sabia o tipo (`RunBeforeSendArgs.resposta`, 0495) e o `persistTrace` jogava fora: o INSERT gravava só o veto, então TODO veto era lido como resposta. Dois efeitos: a rota de retenção (`app/api/v1/conversations/[id]/retention/route.ts`) avaliava só a janela `resposta_*` para um disparo de follow-up/campanha e dizia "fora da janela"/"resolvida" com o par de horas errado, e o histórico não tinha por onde distinguir um disparo segurado às 3h de uma resposta. Coluna `tipo_envio text` NULL-ável, SEM backfill e com CHECK de vocabulário fechado (`resposta`/`disparo`, par no invariante `vocabulario-banco-x-typescript` contra `TipoDeEnvio`): `null` é linha anterior a esta migration, passa no CHECK e continua sendo tratada como `resposta` (o comportamento de antes, zero mudança para dado legado) — a única escrita é `tipoDeEnvio()` em `lib/agent-engine/guardrails/before-send.ts`. A coluna só REGISTRA; a única mudança de veto do PR é no código: o aviso de escalação nascido dentro de um follow-up passa a ser julgado pela janela de disparo (`window_*`) em vez da de resposta (`resposta_*`) — com as janelas padrão, iguais, nada muda. Aditiva e idempotente (`add column if not exists`; o CHECK sob guarda de `pg_constraint`); apêndice no fim do `baseline.sql`. Gate: `lib/agent-engine/agent/aviso-de-escalacao.test.ts` (a escalação dentro de um follow-up sai como `resposta: false`) e `tests/unit/janela-de-resposta-nos-tres-caminhos.test.ts` (a rota continua julgando cada tipo pela janela certa).
-- 0535: o trace do before_send guarda o TIPO do envio vetado (#2112).
--
-- O DEFEITO: `persistTrace` (`lib/agent-engine/guardrails/before-send.ts`)
-- escrevia `vetoed_gate`/`vetoed_code` e descartava `args.resposta` — o único
-- sinal de se a tentativa era uma RESPOSTA a quem escreveu ou um DISPARO de
-- follow-up. Sem a coluna, todo consumidor assumia resposta:
--
--   - a rota de retenção (`[id]/retention/route.ts`) avaliava TODO veto contra a
--     janela `resposta_*` (#1984). Um disparo retido às 3h aparecia ou como
--     "resolvido" (janela de resposta aberta) ou como "segurado pela proteção"
--     citando o par de horas de uma resposta que ninguém escreveu;
--   - o histórico não respondia "seguramos um DISPARO" — era só um código de veto.
--
-- O QUE ESTA COLUNA NÃO MEXE: nenhum gate muda de comportamento por causa dela.
-- Ela REGISTRA uma decisão que a cadeia já tomou (`RunBeforeSendArgs.resposta`,
-- default `false` = disparo, 0495); quem decide a janela continua sendo o gate.
-- A única mudança de veto do PR que a traz está no CÓDIGO, não aqui: o aviso de
-- escalação que nasce dentro de um follow-up passa a sair como disparo e a ser
-- julgado pela janela `window_*` (antes, sempre `resposta_*`). Com as janelas
-- padrão (7h-22h nas duas) o efeito é nulo; com janelas diferentes, muda.
--
-- POR QUE NULL-ÁVEL E SEM BACKFILL: as linhas antigas não sabem o que eram —
-- inventar `disparo` nelas mudaria o aviso de retenção de conversa antiga sem
-- ninguém ter medido, e `resposta` é exatamente o que o código de antes assumia.
-- `null` lido como `resposta` mantém cada linha legada com o sentido de sempre.
--
-- COM CHECK (`resposta`/`disparo`): é vocabulário FECHADO e, ao contrário de
-- `crm_lead_activities.type`, nenhum clone pode ter valor legado nesta coluna —
-- ela nasce aqui, e as linhas antigas ficam `null`, que passa no CHECK. O par
-- banco × TypeScript (`TipoDeEnvio`) é vigiado por
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
alter table public.before_send_traces
  add column if not exists tipo_envio text;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'before_send_traces_tipo_envio_check'
                    and conrelid = 'public.before_send_traces'::regclass) then
    alter table public.before_send_traces
      add constraint before_send_traces_tipo_envio_check
      check (tipo_envio in ('resposta', 'disparo'));
  end if;
end $$;
