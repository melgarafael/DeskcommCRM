import { beforeAll, describe, expect, it } from "vitest";

import { PROVEDORES_DE_COBRANCA } from "@/lib/cobranca/vocabulario";

import { countAs, sql } from "./gov-helpers";
import { criarOrg, criarUsuarios, erroDe, numero, uuid, valor, vincular } from "./cobranca-helpers";

/**
 * O ARQUIVO DO WEBHOOK DE COBRANÇA — invariante 8 e a parte de
 * `webhook_events_log` do invariante 1 da spec da cobrança do revendedor
 * (§2.4, §12), migration 0601.
 *
 * A linha de cobrança nasce com `organization_id` NULO e corpo `{id,type}`. A
 * policy de leitura da tabela (`webhook_events_log_tenant_read`) vale para
 * QUALQUER membro, sem papel: é a org nula que esconde a linha do tenant. O
 * `23505` de `uniq_webhook_events_log_cobranca` é a idempotência que a rota do
 * webhook trata (linha `processed` → 200; linha `received` → reemite o sinal).
 *
 * Arquivo próprio, e não um caso a mais em cobranca-isolamento.test.ts:
 * tests/invariants/** é congelado, e editar aquele arquivo seria `M`.
 */

const P = "c0b3a001-0000-4000-8000";
const ORG_A = uuid(P, 1);
const VIEWER_A = uuid(P, 11);

/** INSERT de uma linha do arquivo na forma que a rota de cobrança grava (§2.4). SEM `;`. */
function evento(provider: string, externalId: string, org: string | null = null): string {
  return `insert into public.webhook_events_log (organization_id, provider, raw_body, external_id, event_type, status)
    values (${org === null ? "null" : `'${org}'`}, '${provider}',
            '{"id":"${externalId}","type":"invoice.paid"}', '${externalId}', 'invoice.paid', 'received')`;
}

beforeAll(() => {
  criarUsuarios([[VIEWER_A, "viewer-a-0601@invariant.test"]]);
  criarOrg(ORG_A, "cob-webhook-a");
  vincular(VIEWER_A, ORG_A, "viewer");
});

describe("webhook_events_log aceita os provedores de cobrança", () => {
  it("⭐ todo provedor do vocabulário da cobrança entra no arquivo", () => {
    expect(PROVEDORES_DE_COBRANCA.length).toBeGreaterThan(0);
    for (const provedor of PROVEDORES_DE_COBRANCA) {
      expect(erroDe(`${evento(provedor, `evt_aceito_${provedor}`)};`), provedor).toBe("");
    }
  });

  it("controle: provedor de fora continua recusado pelo CHECK", () => {
    const e = erroDe(`${evento("mercadopago", "evt_recusado")};`);
    expect(e).toContain("23514");
    expect(e).toContain("webhook_events_log_provider_check");
  });
});

describe("inv. 8 — um evento de cobrança, uma linha", () => {
  it("⭐ o mesmo evento do mesmo provedor é 23505 no índice de cobrança", () => {
    sql(`${evento("stripe", "evt_repetido")};`);
    const e = erroDe(`${evento("stripe", "evt_repetido")};`);
    expect(e).toContain("23505");
    expect(e).toContain("uniq_webhook_events_log_cobranca");
    expect(
      numero(`select count(*) from public.webhook_events_log where provider = 'stripe' and external_id = 'evt_repetido';`),
    ).toBe(1);
  });

  it("o mesmo id em outro provedor de cobrança é outro evento", () => {
    sql(`${evento("stripe", "evt_dos_dois")};`);
    expect(erroDe(`${evento("asaas", "evt_dos_dois")};`)).toBe("");
  });

  it("controle: o índice é parcial — o arquivo dos canais segue aceitando id repetido", () => {
    sql(`${evento("generic", "evt_de_canal", ORG_A)};`);
    expect(erroDe(`${evento("generic", "evt_de_canal", ORG_A)};`)).toBe("");
    expect(
      numero(`select count(*) from public.webhook_events_log where provider = 'generic' and external_id = 'evt_de_canal';`),
    ).toBe(2);
  });

  it("o índice é único e tem o predicado da spec", () => {
    const def = valor(`select pg_get_indexdef('public.uniq_webhook_events_log_cobranca'::regclass);`);
    expect(def).toContain("CREATE UNIQUE INDEX");
    expect(def).toContain("(provider, external_id)");
    expect(def).toContain("'stripe'::text, 'asaas'::text");
  });
});

describe("inv. 1 (parte do arquivo) — o tenant não lê a linha de cobrança", () => {
  it("⭐ viewer de A lê 0 linhas com provider stripe ou asaas", () => {
    sql(`${evento("stripe", "evt_invisivel")}; ${evento("asaas", "evt_invisivel")};`);
    expect(
      numero(`select count(*) from public.webhook_events_log where provider in ('stripe', 'asaas');`),
    ).toBeGreaterThanOrEqual(2);
    expect(
      countAs(VIEWER_A, `select count(*) from public.webhook_events_log where provider in ('stripe', 'asaas');`),
    ).toBe(0);
  });

  it("controle: o mesmo viewer lê a linha de canal da própria org (a sonda enxerga)", () => {
    sql(`${evento("generic", "evt_visivel", ORG_A)};`);
    expect(countAs(VIEWER_A, `select count(*) from public.webhook_events_log where external_id = 'evt_visivel';`)).toBe(1);
  });
});
