import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A PODA DAS TABELAS APPEND-ONLY DA IA CONTRA UM POSTGRES DE VERDADE (0587).
 *
 * O risco do conserto é apagar o que ainda tem leitor. As regras que impedem
 * isso só existem no SQL — o último checkpoint de cada fronteira, o checkpoint
 * que um job vivo vai ler, o último envio de cada número, a janela do
 * anti-repetição, o piso no corpo e o privilégio de quem chama —, então só um
 * Postgres com o MESMO `baseline.sql` do kit as mede.
 *
 * Banco novo por arquivo (`tests/db/banco-limpo-por-arquivo.ts`): as funções
 * não têm seletor de organização, e é isso que deixa as contagens exatas aqui.
 */

const ORG = "05870587-0000-4000-8000-000000000001";
const CONTATO = "05870587-0000-4000-8000-000000000002";
const CONTATO_2 = "05870587-0000-4000-8000-000000000003";
const CONTATO_3 = "05870587-0000-4000-8000-000000000004";
const SESSAO = "05870587-0000-4000-8000-000000000005";
const SESSAO_2 = "05870587-0000-4000-8000-000000000006";
const CONVERSA = "05870587-0000-4000-8000-000000000007";

const FUNCOES = [
  "fn_expurgar_telemetria_de_ia_vencida",
  "fn_expurgar_ritmo_de_envio_vencido",
  "fn_expurgar_copias_enviadas_vencidas",
  "fn_expurgar_checkpoints_superados",
] as const;

const conta = (q: string): number => Number(lastLine(sql(q)));

/** Insere um checkpoint e devolve o id. `fronteira` = [conversa, revisão, demanda, revisão da demanda]. */
function checkpoint(opts: {
  contato?: string;
  fronteira?: [string | null, number | null, string | null, number | null];
  idadeDias: number;
  jobId?: string | null;
}): string {
  const [conv, rev, dem, demRev] = opts.fronteira ?? [null, null, null, null];
  const lit = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${v}'`);
  return lastLine(
    // Por CTE e não `insert ... returning` solto: o psql imprime a etiqueta
    // `INSERT 0 1` depois da linha, e a última linha deixaria de ser o id.
    sql(`
      with novo as (
        insert into lead_checkpoints
          (organization_id, contact_id, job_id, conversation_id, service_revision, demanda_id, demanda_revision, created_at)
        values ('${ORG}', '${opts.contato ?? CONTATO}', ${lit(opts.jobId ?? null)}, ${lit(conv)}, ${lit(rev)},
                ${lit(dem)}, ${lit(demRev)}, now() - interval '${opts.idadeDias} days')
        returning id
      )
      select id from novo;
    `),
  );
}

const existe = (id: string): boolean => conta(`select count(*) from lead_checkpoints where id = '${id}'`) === 1;

beforeAll(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-retencao-0587', 'Org Retencao 0587 LTDA', 'Org 0587')
      on conflict (id) do nothing;
    insert into contacts (id, organization_id, name, phone_number) values
      ('${CONTATO}', '${ORG}', 'Lead 0587 A', '+5511900587001'),
      ('${CONTATO_2}', '${ORG}', 'Lead 0587 B', '+5511900587002'),
      ('${CONTATO_3}', '${ORG}', 'Lead 0587 C', '+5511900587003')
      on conflict (id) do nothing;
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name) values
      ('${SESSAO}', '${ORG}', '\\x00', 'retencao-0587-a'),
      ('${SESSAO_2}', '${ORG}', '\\x00', 'retencao-0587-b')
      on conflict (id) do nothing;
    insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'ai_handling')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`
    delete from lead_checkpoints where organization_id = '${ORG}';
    delete from job_queue where organization_id = '${ORG}';
    delete from pacing_ledger where organization_id = '${ORG}';
    delete from outbound_copies where organization_id = '${ORG}';
    delete from channel_knobs where organization_id = '${ORG}';
    delete from llm_calls where organization_id = '${ORG}';
    delete from metrics where organization_id = '${ORG}';
    delete from skill_activations where organization_id = '${ORG}';
    delete from ai_router_decisions where organization_id = '${ORG}';
  `);
});

describe("lead_checkpoints — o último de cada fronteira sobrevive", () => {
  it("apaga só o SUPERADO dentro da mesma fronteira, nunca o último dela", () => {
    // F1 e F2 diferem SÓ na revisão do atendimento: se a regra fosse "o último
    // do contato", o único de F2 (k4) sairia junto com k1/k2.
    const k1 = checkpoint({ fronteira: [CONVERSA, 1, null, null], idadeDias: 400 });
    const k2 = checkpoint({ fronteira: [CONVERSA, 1, null, null], idadeDias: 300 });
    const k3 = checkpoint({ fronteira: [CONVERSA, 1, null, null], idadeDias: 200 });
    const k4 = checkpoint({ fronteira: [CONVERSA, 2, null, null], idadeDias: 400 });
    // F3 é a fronteira toda nula (o checkpoint da retomada, `job_id` nulo):
    // `is not distinct from` precisa agrupar nulo com nulo.
    const k5 = checkpoint({ idadeDias: 400 });
    const k6 = checkpoint({ idadeDias: 350 });
    // Outro contato, um só checkpoint, velho: é o último dele.
    const k7 = checkpoint({ contato: CONTATO_2, idadeDias: 400 });

    expect(conta(`select public.fn_expurgar_checkpoints_superados(0, 10000)`)).toBe(3);
    expect([k1, k2, k5].map(existe)).toEqual([false, false, false]);
    expect([k3, k4, k6, k7].map(existe)).toEqual([true, true, true, true]);
  });

  it("o mais recente de cada contato e de cada conversa continua sendo o mesmo depois da poda", () => {
    // É a pergunta de todos os outros leitores (resposta do caso, handoff,
    // retomada, score, flywheel): o último por contato e por conversa.
    checkpoint({ fronteira: [CONVERSA, 1, null, null], idadeDias: 300 });
    checkpoint({ fronteira: [CONVERSA, 1, null, null], idadeDias: 200 });
    checkpoint({ idadeDias: 100 });
    const ultimo = (filtro: string) =>
      lastLine(sql(`select id from lead_checkpoints where organization_id = '${ORG}' ${filtro} order by seq desc limit 1`));
    const antes = [ultimo(`and contact_id = '${CONTATO}'`), ultimo(`and conversation_id = '${CONVERSA}'`)];
    expect(conta(`select public.fn_expurgar_checkpoints_superados(0, 10000)`)).toBe(1);
    expect([ultimo(`and contact_id = '${CONTATO}'`), ultimo(`and conversation_id = '${CONVERSA}'`)]).toEqual(antes);
  });

  it("não apaga o checkpoint que um job pending/running vai ler", () => {
    sql(`
      insert into job_queue (id, organization_id, contact_id, kind, payload, status, created_at) values
        ('05870587-1111-4000-8000-000000000001', '${ORG}', '${CONTATO}', 'inbound_turn', '{}'::jsonb, 'done', now() - interval '400 days'),
        ('05870587-1111-4000-8000-000000000002', '${ORG}', '${CONTATO}', 'operator_turn',
         '{"origin_job_id":"05870587-1111-4000-8000-000000000001"}'::jsonb, 'pending', now()),
        ('05870587-1111-4000-8000-000000000003', '${ORG}', '${CONTATO_3}', 'inbound_turn', '{}'::jsonb, 'running', now() - interval '400 days');
    `);
    // O do Operador: superado no contato, mas o Operador pendente o lê por
    // `origin_job_id` (checkpointDoJob).
    const doOperador = checkpoint({ idadeDias: 400, jobId: "05870587-1111-4000-8000-000000000001" });
    checkpoint({ idadeDias: 300 });
    // O do job que ainda está rodando: superado, mas o job pode relê-lo.
    const doRodando = checkpoint({ contato: CONTATO_3, idadeDias: 400, jobId: "05870587-1111-4000-8000-000000000003" });
    checkpoint({ contato: CONTATO_3, idadeDias: 300 });

    expect(conta(`select public.fn_expurgar_checkpoints_superados(0, 10000)`)).toBe(0);
    expect([doOperador, doRodando].map(existe)).toEqual([true, true]);

    // Controle: os jobs terminam e a proteção acaba — não é a idade que salvou.
    sql(`update job_queue set status = 'done' where organization_id = '${ORG}'`);
    expect(conta(`select public.fn_expurgar_checkpoints_superados(0, 10000)`)).toBe(2);
    expect([doOperador, doRodando].map(existe)).toEqual([false, false]);
  });

  it("o piso não é furado: knob 1 não apaga superado de 20 dias", () => {
    const novo = checkpoint({ idadeDias: 20 });
    checkpoint({ idadeDias: 10 });
    expect(conta(`select public.fn_expurgar_checkpoints_superados(1, 10000)`)).toBe(0);
    expect(existe(novo)).toBe(true);
  });

  it("o protegido mais velho não trava o lote (filtro antes do limit)", () => {
    checkpoint({ contato: CONTATO_2, idadeDias: 900 }); // o mais velho: último do contato 2
    const velho = checkpoint({ idadeDias: 400 });
    checkpoint({ idadeDias: 300 });
    expect(conta(`select public.fn_expurgar_checkpoints_superados(0, 1)`)).toBe(1);
    expect(existe(velho)).toBe(false);
  });
});

describe("pacing_ledger — o último envio de cada número fica", () => {
  it("apaga o velho com envio mais novo, guarda o último mesmo velho, e respeita o piso de 2 dias", () => {
    sql(`
      insert into pacing_ledger (organization_id, channel_session_id, sent_at) values
        ('${ORG}', '${SESSAO}', now() - interval '10 days'),
        ('${ORG}', '${SESSAO}', now() - interval '3 days'),
        ('${ORG}', '${SESSAO}', now() - interval '1 day'),
        ('${ORG}', '${SESSAO}', now() - interval '1 hour'),
        ('${ORG}', '${SESSAO_2}', now() - interval '20 days'),
        ('${ORG}', '${SESSAO_2}', now() - interval '15 days');
    `);
    // knob 0 → piso 2: saem os de 10 e 3 dias de S1 e o de 20 de S2; o de 1 dia
    // fica pelo piso, e o de 15 dias de S2 fica por ser o último do número.
    expect(conta(`select public.fn_expurgar_ritmo_de_envio_vencido(0, 10000)`)).toBe(3);
    expect(conta(`select count(*) from pacing_ledger where channel_session_id = '${SESSAO}'`)).toBe(2);
    expect(
      conta(`select count(*) from pacing_ledger where channel_session_id = '${SESSAO_2}' and sent_at < now() - interval '14 days'`),
    ).toBe(1);
  });
});

describe("outbound_copies — a janela do anti-repetição fica", () => {
  function copias(sessao: string, n: number, idadeDias: number): void {
    sql(`
      insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
      select '${ORG}', '${sessao}', 'copia ' || g, md5('copia ' || g), now() - make_interval(days => ${idadeDias}, secs => g)
        from generate_series(1, ${n}) g;
    `);
  }

  it("guarda as últimas 20 do número mesmo velhas e apaga o resto passado do prazo", () => {
    copias(SESSAO, 25, 60);
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(0, 10000)`)).toBe(5);
    expect(conta(`select count(*) from outbound_copies where channel_session_id = '${SESSAO}'`)).toBe(20);
  });

  it("knob windowSize maior que 20 alarga o que fica", () => {
    sql(`
      insert into channel_knobs (organization_id, channel_session_id, spinning_knobs)
      values ('${ORG}', '${SESSAO_2}', '{"windowSize": 30}'::jsonb);
    `);
    copias(SESSAO_2, 25, 60);
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(0, 10000)`)).toBe(0);
  });

  it("o piso de 7 dias não é furado, mesmo fora da janela", () => {
    copias(SESSAO, 25, 3);
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(1, 10000)`)).toBe(0);
  });
});

describe("telemetria da IA — prazo único, piso 100, cópia legada preservada", () => {
  it("apaga o velho das quatro tabelas, guarda o que está acima do piso", () => {
    sql(`
      insert into llm_calls (organization_id, provider, model, created_at) values
        ('${ORG}', 'anthropic', 'claude', now() - interval '150 days'),
        ('${ORG}', 'anthropic', 'claude', now() - interval '50 days');
      insert into metrics (organization_id, name, value, created_at) values
        ('${ORG}', 'run_cost_cents', 1, now() - interval '150 days'),
        ('${ORG}', 'run_cost_cents', 1, now() - interval '50 days');
      insert into skill_activations (organization_id, skill_name, trigger, created_at) values
        ('${ORG}', 'agendar', 'hard', now() - interval '150 days'),
        ('${ORG}', 'agendar', 'hard', now() - interval '50 days');
      insert into ai_router_decisions (organization_id, outcome, created_at) values
        ('${ORG}', 'fallback', now() - interval '150 days'),
        ('${ORG}', 'fallback', now() - interval '50 days');
    `);
    // knob 1 → piso 100: sai o de 150 dias de cada tabela, fica o de 50.
    expect(conta(`select public.fn_expurgar_telemetria_de_ia_vencida(1, 10000)`)).toBe(4);
    for (const t of ["llm_calls", "metrics", "skill_activations", "ai_router_decisions"]) {
      expect(conta(`select count(*) from ${t} where organization_id = '${ORG}'`), t).toBe(1);
    }
  });

  it("a cópia legada da 0130 nunca sai (o update.sh a recopiaria)", () => {
    sql(`
      insert into llm_calls (organization_id, provider, model, created_at, legacy_invocation_id)
      values ('${ORG}', 'desconhecido', 'gpt', now() - interval '900 days', gen_random_uuid());
    `);
    expect(conta(`select public.fn_expurgar_telemetria_de_ia_vencida(0, 10000)`)).toBe(0);
  });
});

describe("as quatro funções não são executáveis por anon nem authenticated", () => {
  it.each(FUNCOES)("%s", (fn) => {
    for (const papel of ["anon", "authenticated"]) {
      expect(sql(`select has_function_privilege('${papel}', 'public.${fn}(int,int)', 'EXECUTE')`), papel).toBe("f");
    }
    // Probe positivo: revogar de todo mundo deixaria os dois acima verdes e
    // o cron morto.
    expect(sql(`select has_function_privilege('service_role', 'public.${fn}(int,int)', 'EXECUTE')`)).toBe("t");
  });
});
