import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * O EXPURGO DA PROSPECÇÃO NATIVA CONTRA UM POSTGRES DE VERDADE — issue #1313.
 *
 * ─── Por que esta existe e a declaração não bastou ────────────────────────
 *
 * O primeiro PR sobre esta issue só DECLAROU prazos em `politica.ts`. A
 * revisão mediu o repo e achou o que a declaração escondia: nenhum código
 * apagava `prospecting_candidates` por idade, e a razão escrita da isenção no
 * teste de guarda ("poda pelo admin client") apontava uma poda que não
 * existia. Piso que só existe no TypeScript é decorativo — e uma razão
 * escrita que não corresponde ao código deixa o gate verde sem medir nada.
 *
 * Esta suíte é o que sobra quando a mentira sai: o banco de verdade, o
 * `baseline.sql` que o kit self-host aplica, e os 7 casos da matriz que o
 * @csy20 detalhou na própria #1313.
 *
 * ─── Os dois eixos que a issue aponta como os mais caros ──────────────────
 *
 * 1. Quem NUNCA falou com a empresa não fica para sempre (o titular nem sabe
 *    que está lá);
 * 2. o tombstone de supressão (0370) NUNCA sai — sem ele a reimportação
 *    traz de volta quem exerceu opt-out/exclusão, e alcançar de menos em
 *    expurgo LGPD é violação, não é apagamento.
 */

const ORG = "26400000-0000-4000-8000-000000000001";
const CAMP = "26400000-0000-4000-8000-000000000002";

/** Um id determinístico por caso — sem colisão entre os testes deste arquivo. */
function id(n: number): string {
  return `26400000-1111-4000-8000-${String(n).padStart(12, "0")}`;
}

function conta(query: string): number {
  return Number(lastLine(sql(query)));
}

interface Candidato {
  id: string;
  /** Idade em dias ANTES de agora (`created_at`). */
  idadeDias: number;
  status?: string;
  /** Quando houve tentativa — `null` = nunca contatado. */
  tentativaDias?: number | null;
  /** `true` grava os tokens de supressão (tombstone de LGPD da 0370). */
  suprimido?: boolean;
  placeId?: string;
}

function semear(opts: Candidato): void {
  const status = opts.status ?? "new";
  const tentativa =
    opts.tentativaDias === null || opts.tentativaDias === undefined
      ? "null"
      : `now() - interval '${opts.tentativaDias} days'`;
  const supressao = opts.suprimido
    ? `extensions.gen_random_bytes(32)`
    : "null";
  sql(`
    insert into prospecting_candidates (
      id, organization_id, campaign_id, place_id, phone, data, status,
      attempted_at, created_at, suppression_salt
    ) values (
      '${opts.id}', '${ORG}', '${CAMP}',
      '${opts.placeId ?? `lugar-${opts.id}`}',
      '+55419${opts.id.slice(-8)}',
      '{"name":"Pessoa Teste","address":"Rua X"}'::jsonb,
      '${status}',
      ${tentativa},
      now() - interval '${opts.idadeDias} days',
      ${supressao}
    );
  `);
}

beforeEach(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-prospeccao-1313', 'Org Prospeccao LTDA', 'Org Prospeccao')
      on conflict (id) do nothing;
    insert into prospecting_campaigns (id, organization_id, request_id, name, search)
      values ('${CAMP}', '${ORG}', '${id(900)}', 'Campanha da Poda', '{}'::jsonb)
      on conflict (id) do nothing;
    delete from prospecting_candidates where organization_id = '${ORG}';
  `);
});

describe("fn_expurgar_prospeccao_vencida — o prazo que a declaração prometia", () => {
  it("1. nunca contatado e vencido (400d) é removido", () => {
    semear({ id: id(1), idadeDias: 400, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(1);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(1)}'`)).toBe(0);
  });

  it("2. candidato recente permanece", () => {
    semear({ id: id(2), idadeDias: 10, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(0);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(2)}'`)).toBe(1);
  });

  it("3. o relógio conta da TENTATIVA quando houve: linha de 400d contatada ontem permanece", () => {
    // Sem `coalesce(attempted_at, created_at)`, um candidato pesquisado há
    // um ano e contatado ontem cairia no meio do funil — a segunda metade da
    // matriz do csy20 ("contatado respeita o prazo") com um prazo único.
    semear({ id: id(3), idadeDias: 400, tentativaDias: 1, status: "sent" });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(0);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(3)}'`)).toBe(1);
    // E a irmã da frase: contatado há 400d, sem nada recente, sai.
    semear({ id: id(4), idadeDias: 400, tentativaDias: 400, status: "sent" });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(1);
  });

  it("4. queued e sending permanecem mesmo muito velhos (trabalho vivo)", () => {
    // A guarda é incondicional de propósito: apagar no meio de um envio é pior
    // do que a tabela crescer. Um 'sending' de 400d é um worker morto, não
    // envio em andamento — mas a decisão é do DONO do dado (quem retoma a
    // fila), não do cron da madrugada.
    semear({ id: id(5), idadeDias: 400, tentativaDias: 400, status: "queued" });
    semear({ id: id(6), idadeDias: 400, tentativaDias: null, status: "sending" });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(0);
    expect(conta(`select count(*) from prospecting_candidates where organization_id = '${ORG}'`)).toBe(2);
  });

  it("5. o tombstone com suppression_* permanece mesmo muito antigo", () => {
    // O caso que a issue aponta como o mais caro. O tombstone é a garantia de
    // opt-out contra reimportações FUTURAS — apagá-lo seria a violação.
    semear({ id: id(7), idadeDias: 900, tentativaDias: null, status: "skipped", suprimido: true });
    semear({ id: id(8), idadeDias: 900, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(1);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(7)}'`)).toBe(1);
    expect(
      conta(
        `select count(*) from prospecting_candidates where id = '${id(7)}' and suppression_salt is not null`,
      ),
    ).toBe(1);
  });

  it("6. depois da poda, o trigger ainda barra a reimportação da pessoa suprimida", () => {
    // A sequência inteira da issue num caso só: expurgo roda, o dado comum
    // sai, o tombstone fica, e a porta que a anonimização fechou continua
    // fechada (trigger `prospecting_refuse_erased` da 0370).
    const salt = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    sql(`
      insert into prospecting_candidates (
        id, organization_id, campaign_id, place_id, data, status,
        created_at, suppression_salt, suppression_place
      ) values (
        '${id(10)}', '${ORG}', '${CAMP}', 'redacted:${id(10)}',
        '{"name":"[anonimizado]"}'::jsonb, 'skipped',
        now() - interval '900 days',
        decode('${salt}', 'hex'),
        extensions.hmac(convert_to('lugar-exato-da-pessoa', 'UTF8'), decode('${salt}', 'hex'), 'sha256')
      );
    `);
    semear({ id: id(11), idadeDias: 500, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(1);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(10)}'`)).toBe(1);
    // Reimportação: o mesmo lugar que estava suprimido volta a ser raspado.
    // O trigger devolve NULL = a linha NÃO entra. Contagem não muda.
    sql(`
      insert into prospecting_candidates (
        id, organization_id, campaign_id, place_id, data
      ) values (
        '${id(12)}', '${ORG}', '${CAMP}', 'lugar-exato-da-pessoa',
        '{"name":"Reimportada"}'::jsonb
      );
    `);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(12)}'`)).toBe(0);
    expect(
      conta(`select count(*) from prospecting_candidates where place_id = 'lugar-exato-da-pessoa'`),
    ).toBe(0);
  });

  it("7a. o piso mora no CORPO: pedir 1 dia aplica 90, e a linha de 89d fica", () => {
    // Um `psql` na mão passando 1 não vira apagador de rastro recente — é
    // isto que "piso dentro do corpo" quer dizer, e é o que o teste de guarda
    // de unidade confere no baseline; aqui é o banco que confirma.
    semear({ id: id(13), idadeDias: 89, tentativaDias: null });
    semear({ id: id(14), idadeDias: 91, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(1, 1000)")).toBe(1);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(13)}'`)).toBe(1);
    expect(conta(`select count(*) from prospecting_candidates where id = '${id(14)}'`)).toBe(0);
  });

  it("7b. o lote é cortado no limite: 3 vencidos com p_limite=2 devolvem 2 e sobra 1", () => {
    // O laço do cron PARA no primeiro lote incompleto — sem esta propriedade
    // a primeira rodada de uma instalação antiga seguraria o `curl` do cron
    // até o timeout. É a mesma régua de `retencao-poda-em-lotes.test.ts`, mas
    // medindo o CORPO da função em vez do mock.
    semear({ id: id(15), idadeDias: 500, tentativaDias: null });
    semear({ id: id(16), idadeDias: 501, tentativaDias: null });
    semear({ id: id(17), idadeDias: 502, tentativaDias: null });
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 2)")).toBe(2);
    expect(conta(`select count(*) from prospecting_candidates where organization_id = '${ORG}'`)).toBe(1);
    expect(conta("select public.fn_expurgar_prospeccao_vencida(365, 1000)")).toBe(1);
  });
});

describe("fn_expurgar_prospeccao_vencida — o privilégio, medido", () => {
  it("anon e authenticated ficam SEM execute; service_role fica COM", () => {
    // As DUAS origens de EXECUTE: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
    // FUNCTIONS TO anon` do baseline e o grant implícito a PUBLIC. Fechar uma
    // só deixa a função exposta com o gate verde — é por isso que o revoke é
    // duplo e este teste conta as duas.
    for (const papel of ["public", "anon", "authenticated"]) {
      expect(
        sql(
          `select has_function_privilege('${papel}', 'public.fn_expurgar_prospeccao_vencida(int,int)', 'EXECUTE')`,
        ).trim(),
        `papel ${papel} não deveria ter EXECUTE`,
      ).toBe("f");
    }
    expect(
      sql(
        `select has_function_privilege('service_role', 'public.fn_expurgar_prospeccao_vencida(int,int)', 'EXECUTE')`,
      ).trim(),
    ).toBe("t");
  });
});
