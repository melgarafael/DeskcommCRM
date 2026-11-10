/**
 * O TRAÇO DO TURNO TEM PRAZO — E O LEITOR ALCANÇA O QUE FICOU (issue #3201).
 *
 * A 0721 passou a gravar uma linha por turno em `agent_turn_traces` e nada
 * apagava: a tabela crescia desde a instalação. A 0778 traz
 * `fn_expurgar_traco_do_turno_vencido` no molde da 0587, com a JANELA DA
 * TELEMETRIA DA IA (400 / piso 100).
 *
 * O risco desta entrega não é apagar de menos, é apagar o que o leitor mostra.
 * As duas regras que impedem isso só existem no banco e são medidas aqui:
 *   • o piso mora no CORPO da função (nem a service key apaga aquém dele);
 *   • o leitor (`/api/v1/ai/turn-traces`) começa em `now() - retenção`, então
 *     nada que ele alcança está do lado de lá do corte.
 *
 * Roda em `pnpm test:db` (precisa de Postgres com o baseline aplicado).
 */
import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "07780778-0000-4000-8000-000000000001";
const ORG_2 = "07780778-0000-4000-8000-000000000002";
const CONVERSA = "07780778-0000-4000-8000-000000000003";

const conta = (q: string): number => Number(lastLine(sql(q)));

/**
 * Semeia um traço com a idade pedida. `previa` usa a outra chave do CHECK da
 * 0721 (`preview_run_id`): as duas formas da tabela precisam envelhecer igual.
 */
function traco(opts: { idadeDias: number; org?: string; previa?: boolean }): string {
  const org = opts.org ?? ORG;
  const colunas = opts.previa === true ? "preview_run_id, is_dry_run" : "job_id, is_dry_run";
  // Chave própria por linha: `agent_turn_traces_job_idx` é ÚNICO no `job_id`
  // (0721) — dois turnos reais com o mesmo id colidiriam, como colidiriam dois
  // `preview_run_id` iguais.
  const valores = opts.previa === true ? `'run-${randomUUID()}', true` : `'${randomUUID()}', false`;
  return lastLine(
    // Por CTE, e não `insert ... returning`: o psql imprime `INSERT 0 1` depois
    // da linha e a última linha deixaria de ser o id.
    sql(`
      with novo as (
        insert into agent_turn_traces
          (organization_id, ${colunas}, conversation_id, status, provider, model,
           tokens_in, tokens_out, latency_ms, created_at, updated_at)
        values ('${org}', ${valores}, '${CONVERSA}', 'completed', 'anthropic', 'claude',
                10, 5, 900, now() - interval '${opts.idadeDias} days',
                now() - interval '${opts.idadeDias} days')
        returning id
      )
      select id from novo;
    `),
  );
}

const existe = (id: string): boolean =>
  conta(`select count(*) from agent_turn_traces where id = '${id}'`) === 1;

beforeAll(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'org-traco-0778', 'Org Traco 0778 LTDA', 'Org 0778'),
      ('${ORG_2}', 'org-traco-0778-b', 'Org Traco 0778 B LTDA', 'Org 0778 B')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`delete from agent_turn_traces where organization_id in ('${ORG}', '${ORG_2}')`);
});

describe("fn_expurgar_traco_do_turno_vencido — apaga o vencido, guarda o resto", () => {
  it("apaga o traço mais velho que a janela e guarda o recente, nas duas formas da chave", () => {
    const velho = traco({ idadeDias: 150 });
    const recente = traco({ idadeDias: 20 });
    const previaVelha = traco({ idadeDias: 150, previa: true });

    // knob 0 → piso 100: o de 150 dias sai, o de 20 fica.
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(0, 10000)")).toBe(2);
    expect([existe(velho), existe(recente), existe(previaVelha)]).toEqual([false, true, false]);
  });

  it("o piso de 100 dias não é furado por knob nenhum", () => {
    const deNoventa = traco({ idadeDias: 90 });
    const deCentoEVinte = traco({ idadeDias: 120 });

    // knob 1 → piso 100: só o de 120 sai. O de 90 fica, mesmo com o operador
    // pedindo 1 dia — investigação de turno é coisa de semanas, não de horas.
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(1, 10000)")).toBe(1);
    expect([existe(deNoventa), existe(deCentoEVinte)]).toEqual([true, false]);
  });

  it("sem argumento nenhum, a janela é a da telemetria da IA: 400 dias", () => {
    const deTrezentosENoventa = traco({ idadeDias: 390 });
    const deQuatrocentosEDez = traco({ idadeDias: 410 });

    // Default da função = default de AI_TELEMETRY_RETENTION_DAYS (400).
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido()")).toBe(1);
    expect([existe(deTrezentosENoventa), existe(deQuatrocentosEDez)]).toEqual([true, false]);
  });

  it("o lote é respeitado: p_limite 2 apaga 2, e a sobra fica para a próxima rodada", () => {
    // 500+ dias: vencidos para o prazo de 400 pedido abaixo. O piso é 100, então
    // qualquer coisa acima disso obedece ao `p_retencao_dias` que a chamada passa.
    const velhos = [0, 1, 2].map((i) => traco({ idadeDias: 500 + i }));

    // A ordem do dreno é `created_at` ascendente: o "mais velho" é o de 502
    // dias, então os dois primeiros lotes levam os mais antigos — o de 500 fica.
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(400, 2)")).toBe(2);
    expect(velhos.map(existe)).toEqual([true, false, false]);

    // O segundo lote fecha o dreno — o laço do cron não gira à toa.
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(400, 2)")).toBe(1);
    expect(velhos.map(existe)).toEqual([false, false, false]);
  });

  it("a poda não tem seletor de linha: apaga de TODAS as organizações", () => {
    // É o contrato da família da 0587 — e o que impede a função de virar porta
    // para apagar o traço de um vizinho escolhendo a organização.
    const daOrgA = traco({ idadeDias: 500 });
    const daOrgB = traco({ idadeDias: 500, org: ORG_2 });

    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(400, 10000)")).toBe(2);
    expect([existe(daOrgA), existe(daOrgB)]).toEqual([false, false]);
  });
});

describe("o leitor alcança exatamente o que a poda guarda", () => {
  it("nada que o leitor mostra (janela recente) é apagado", () => {
    const agora = traco({ idadeDias: 0 });
    // 5 dias, e não 7: a linha de "7 dias" cai do lado de fora da janela de 7
    // dias por alguns segundos de relógio, e o caso mediria o arredondamento em
    // vez da regra.
    const deCincoDias = traco({ idadeDias: 5 });
    const deTrintaDias = traco({ idadeDias: 30 });

    // A rodada diária, com o padrão de 400 dias.
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido()")).toBe(0);

    // A MESMA pergunta que a rota faz: o traço da janela dela, da organização.
    const lidosPeloLeitor = conta(`
      select count(*) from agent_turn_traces
       where organization_id = '${ORG}'
         and created_at >= now() - interval '7 days'
    `);
    expect(lidosPeloLeitor).toBe(2);
    expect([existe(agora), existe(deCincoDias), existe(deTrintaDias)]).toEqual([true, true, true]);
  });

  it("depois do expurgo o leitor continua lendo o que ficou (a linha do turno não desaparece)", () => {
    const velho = traco({ idadeDias: 200 });
    const novo = traco({ idadeDias: 1 });
    expect(conta("select public.fn_expurgar_traco_do_turno_vencido(100, 10000)")).toBe(1);
    expect(existe(velho)).toBe(false);

    // O que o leitor devolve do sobrevivente: os metadados que ele consome.
    const linha = lastLine(
      sql(`
        select status || '|' || provider || '|' || model || '|' || tokens_in
          from agent_turn_traces
         where organization_id = '${ORG}' and id = '${novo}'
      `),
    );
    expect(linha).toBe("completed|anthropic|claude|10");
  });
});

describe("a função não é executável por anon nem authenticated", () => {
  it.each(["anon", "authenticated"])("%s não executa", (papel) => {
    expect(
      sql(
        `select has_function_privilege('${papel}', 'public.fn_expurgar_traco_do_turno_vencido(int,int)', 'EXECUTE')`,
      ),
    ).toBe("f");
  });

  it("controle positivo: service_role executa", () => {
    // Revogar de todos deixaria os dois casos acima verdes e o cron morto.
    expect(
      sql(
        "select has_function_privilege('service_role', 'public.fn_expurgar_traco_do_turno_vencido(int,int)', 'EXECUTE')",
      ),
    ).toBe("t");
  });
});
