import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * O PRAZO PEDIDO É O PRAZO APLICADO — não só o piso (0587).
 *
 * `retencao-das-tabelas-da-ia.test.ts` chama as quatro funções só com knob 0 ou
 * 1, isto é, sempre NO piso. Uma regressão que trocasse `v_dias` pelo piso
 * passaria lá inteira: a telemetria seria apagada aos 100 dias, não aos 400 que
 * toda instalação roda. Aqui cada função é chamada (a) com um prazo ACIMA do
 * piso e (b) com `null` — o padrão —, e cada caso guarda uma linha mais velha
 * que o piso e mais nova que o prazo: ela só sobrevive se o prazo pedido valeu.
 *
 * Arquivo novo e não caso novo no irmão: `tests/invariants/**` é congelado pelo
 * pre-commit (`loop/hooks/freeze-invariants.sh`) — acrescentar é permitido,
 * editar não.
 */

const ORG = "05870587-2222-4000-8000-000000000001";
const CONTATO = "05870587-2222-4000-8000-000000000002";
const SESSAO = "05870587-2222-4000-8000-000000000003";

const conta = (q: string): number => Number(lastLine(sql(q)));

beforeAll(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-retencao-0587-prazo', 'Org Retencao 0587 Prazo LTDA', 'Org 0587 Prazo')
      on conflict (id) do nothing;
    insert into contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Lead 0587 Prazo', '+5511900587101')
      on conflict (id) do nothing;
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESSAO}', '${ORG}', '\\x00', 'retencao-0587-prazo')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`
    delete from lead_checkpoints where organization_id = '${ORG}';
    delete from pacing_ledger where organization_id = '${ORG}';
    delete from outbound_copies where organization_id = '${ORG}';
    delete from llm_calls where organization_id = '${ORG}';
  `);
});

describe("telemetria da IA — padrão 400, piso 100", () => {
  const linhas = (...idades: number[]) =>
    sql(`
      insert into llm_calls (organization_id, provider, model, created_at)
      select '${ORG}', 'anthropic', 'claude', now() - make_interval(days => d) from unnest(array[${idades.join(",")}]) d;
    `);
  const restam = () =>
    sql(`select string_agg((extract(day from now() - created_at))::int::text, ',' order by created_at)
           from llm_calls where organization_id = '${ORG}'`);

  it("prazo 200: a de 150 dias fica, a de 250 sai", () => {
    linhas(250, 150);
    expect(conta(`select public.fn_expurgar_telemetria_de_ia_vencida(200, 10000)`)).toBe(1);
    expect(restam()).toBe("150");
  });

  it("null é o padrão de 400: a de 350 dias fica, a de 450 sai", () => {
    linhas(450, 350);
    expect(conta(`select public.fn_expurgar_telemetria_de_ia_vencida(null, 10000)`)).toBe(1);
    expect(restam()).toBe("350");
  });
});

describe("ritmo de envio — padrão 2, piso 2", () => {
  // O envio de 1 hora é o último do número: sem ele, a linha mais nova do caso
  // ficaria pela regra do "último envio", não pelo prazo.
  const envios = (...idadesEmHoras: number[]) =>
    sql(`
      insert into pacing_ledger (organization_id, channel_session_id, sent_at)
      select '${ORG}', '${SESSAO}', now() - make_interval(hours => h) from unnest(array[1, ${idadesEmHoras.join(",")}]) h;
    `);
  const restam = () => conta(`select count(*) from pacing_ledger where organization_id = '${ORG}'`);

  it("prazo 5: o de 4 dias fica, o de 6 sai", () => {
    envios(6 * 24, 4 * 24);
    expect(conta(`select public.fn_expurgar_ritmo_de_envio_vencido(5, 10000)`)).toBe(1);
    expect(restam()).toBe(2);
  });

  it("null é o padrão de 2: o de 36 horas fica, o de 3 dias sai", () => {
    envios(3 * 24, 36);
    expect(conta(`select public.fn_expurgar_ritmo_de_envio_vencido(null, 10000)`)).toBe(1);
    expect(restam()).toBe(2);
  });
});

describe("cópias enviadas — padrão 30, piso 7 (fora da janela de 20)", () => {
  // 20 cópias de ontem enchem a janela do anti-repetição; as duas do caso ficam
  // FORA dela, então só o prazo decide.
  const copias = (...idades: number[]) =>
    sql(`
      insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
      select '${ORG}', '${SESSAO}', 'janela ' || g, md5('janela ' || g), now() - make_interval(days => 1, secs => g)
        from generate_series(1, 20) g;
      insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
      select '${ORG}', '${SESSAO}', 'caso ' || d, md5('caso ' || d), now() - make_interval(days => d)
        from unnest(array[${idades.join(",")}]) d;
    `);
  const restam = () =>
    sql(`select string_agg(normalized_text, ',' order by sent_at)
           from outbound_copies where organization_id = '${ORG}' and normalized_text like 'caso %'`);

  it("prazo 15: a de 10 dias fica, a de 20 sai", () => {
    copias(20, 10);
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(15, 10000)`)).toBe(1);
    expect(restam()).toBe("caso 10");
  });

  it("null é o padrão de 30: a de 25 dias fica, a de 35 sai", () => {
    copias(35, 25);
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(null, 10000)`)).toBe(1);
    expect(restam()).toBe("caso 25");
  });
});

describe("checkpoints superados — padrão 180, piso 30", () => {
  // O checkpoint de ontem é o último do contato (fronteira toda nula): os do
  // caso estão SUPERADOS, então só o prazo decide.
  const checkpoints = (...idades: number[]) =>
    sql(`
      insert into lead_checkpoints (organization_id, contact_id, created_at)
      select '${ORG}', '${CONTATO}', now() - make_interval(days => d) from unnest(array[${idades.join(",")}, 1]) d;
    `);
  const restam = () =>
    sql(`select string_agg((extract(day from now() - created_at))::int::text, ',' order by created_at)
           from lead_checkpoints where organization_id = '${ORG}'`);

  it("prazo 60: o de 45 dias fica, o de 75 sai", () => {
    checkpoints(75, 45);
    expect(conta(`select public.fn_expurgar_checkpoints_superados(60, 10000)`)).toBe(1);
    expect(restam()).toBe("45,1");
  });

  it("null é o padrão de 180: o de 150 dias fica, o de 210 sai", () => {
    checkpoints(210, 150);
    expect(conta(`select public.fn_expurgar_checkpoints_superados(null, 10000)`)).toBe(1);
    expect(restam()).toBe("150,1");
  });
});
