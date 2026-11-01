// @vitest-environment node
/**
 * O Reenviar é a MESMA entrega do disparo original (#1529) — provado pelas
 * portas reais: o motor (`runAutomationForEvent`) e o POST da rota
 * `automation-rules/runs/[runId]/resend`, falando com um receptor HTTP de
 * verdade. Só o banco é falso (um Supabase em memória que entende o recorte
 * de consultas que os dois caminhos fazem).
 *
 * O que cada caso segura:
 *  1. o motor passa a posição da ação na lista INTEIRA de `rule.actions`: o
 *     webhook que é a SEGUNDA ação da regra sai com o id da posição 1;
 *  2. o Reenviar recalcula o MESMO id (tirando a posição antes de filtrar só os
 *     webhooks), continua o Attempt de onde o original parou e aponta o run
 *     novo para o clicado em `detail.resent_from_run_id`;
 *  3. um segundo Reenviar conta as tentativas de TODOS os runs do par
 *     (regra, evento), não só as do run clicado — o Attempt não repete;
 *  4. ação removida entre o disparo e o Reenviar: a que herda a posição sai
 *     com um id NOVO, nunca com o da ação removida (que o receptor já
 *     processou e descartaria como duplicata).
 *
 * Mora em tests/unit (e não ao lado da rota) para não abrir mais uma linha na
 * catraca de marca: os nomes dos cabeçalhos aparecem aqui por extenso.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  criarClientDeSessao: vi.fn(),
  criarClientAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.criarClientDeSessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.criarClientAdmin }));
// O receptor escuta em 127.0.0.1, que os guardas anti-SSRF recusam — e devem.
// Aqui eles não são o assunto; os testes deles moram em outro lugar.
vi.mock("@/lib/automation/outbound-url", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertSafeOutboundUrl: () => undefined,
}));
vi.mock("@/lib/automation/outbound-ip", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertDestinoResolvidoSeguro: async () => undefined,
}));

import "@/lib/automation/actions/call-webhook";
import { idDaEntrega } from "@/lib/automation/actions/call-webhook";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { POST } from "@/app/api/v1/automation-rules/runs/[runId]/resend/route";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const REGRA = "33333333-3333-4333-8333-333333333333";
const EVENTO = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

/**
 * Supabase em memória: `from(tabela)` filtra por `.eq`, `insert` grava e
 * devolve a linha com id, e o construtor é "thenable" como o de verdade.
 */
function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const cliente = {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let inserida: Linha | null = null;
      const linhas = (): Linha[] =>
        inserida
          ? [inserida]
          : (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
      const consulta = {
        select: () => consulta,
        order: () => consulta,
        update: () => consulta,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return consulta;
        },
        insert: (payload: Linha) => {
          inserida = { id: randomUUID(), ...payload };
          (tabelas[tabela] ??= []).push(inserida);
          return consulta;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve({ data: linhas(), error: null }).then(ok, erro),
      };
      return consulta;
    },
  };
  return cliente as unknown as SupabaseClient;
}

type Recebida = Record<string, string | string[] | undefined>;
const recebidas: Recebida[] = [];
const corpos: Array<{ occurred_at: string; happened_at: string }> = [];
let url = "";
let fecharReceptor: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const server = createServer((req, res) => {
    const pedacos: Buffer[] = [];
    req.on("data", (c: Buffer) => pedacos.push(c));
    req.on("end", () => {
      recebidas.push(req.headers);
      corpos.push(JSON.parse(Buffer.concat(pedacos).toString("utf8")));
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `http://127.0.0.1:${port}/hook`;
  fecharReceptor = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await fecharReceptor();
});

beforeEach(() => {
  vi.clearAllMocks();
  recebidas.length = 0;
  corpos.length = 0;
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({ ok: true, user: { id: EU, idioma: "pt-BR" }, org: { orgId: ORG } });
});

function evento(): EventRow & Linha {
  return {
    id: EVENTO,
    organization_id: ORG,
    event_type: "lead.created",
    entity_kind: "crm_lead",
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function reenviar(runId: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/v1/automation-rules/runs/${runId}/resend`, {
      method: "POST",
    }) as unknown as NextRequest,
    { params: Promise.resolve({ runId }) },
  );
}

describe("webhook de saída: o Reenviar é a mesma entrega (#1529)", () => {
  it("motor → Reenviar → Reenviar: mesmo Delivery, Attempt 1, 2, 3 e o run novo aponta o original", async () => {
    const acoes = [
      { type: "acao_inexistente" },
      { type: "call_webhook", config: { url, secret: "s3cr3t" } },
    ];
    const tabelas: Record<string, Linha[]> = {
      automation_rules: [
        {
          id: REGRA,
          organization_id: ORG,
          trigger_event: "lead.created",
          is_active: true,
          name: "Regra de teste",
          conditions: [],
          // O webhook é a SEGUNDA ação: a posição dele é 1 na lista inteira e
          // 0 numa lista filtrada só de webhooks — é isso que o caso separa.
          actions: acoes,
        },
      ],
      event_log: [evento()],
      automation_rule_runs: [],
    };
    const banco = bancoFalso(tabelas);
    deps.criarClientDeSessao.mockResolvedValue(banco);
    deps.criarClientAdmin.mockReturnValue(banco);

    const entrega = idDaEntrega(EVENTO, REGRA, 1, acoes);

    // 1. O disparo do motor.
    await runAutomationForEvent(banco, evento());
    expect(recebidas).toHaveLength(1);
    expect(recebidas[0]?.["x-webhook-delivery"]).toBe(entrega);
    expect(recebidas[0]?.["x-webhook-attempt"]).toBe("1");
    const original = tabelas.automation_rule_runs?.[0];
    if (!original) throw new Error("o motor não gravou o run");
    const resultadoOriginal = (original.actions_result as Array<{ detail?: Linha }>)[1];
    expect(resultadoOriginal?.detail).toMatchObject({ delivery_id: entrega, attempt: 1 });

    // 2. O Reenviar do run original — meses depois do fato (created_at em 2026-01-01).
    const antesDoReenvio = Date.now();
    const primeiro = await reenviar(original.id as string);
    const depoisDoReenvio = Date.now();
    expect(primeiro.status).toBe(201);
    expect(recebidas).toHaveLength(2);
    expect(recebidas[1]?.["x-webhook-delivery"]).toBe(entrega);
    expect(recebidas[1]?.["x-webhook-attempt"]).toBe("2");
    // `occurred_at` segue sendo a hora do ENVIO (contrato público); a do fato
    // vai em `happened_at` e é a mesma no disparo e no Reenviar.
    expect(corpos.map((c) => c.happened_at)).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    const reenviadoEm = Date.parse(corpos[1]?.occurred_at ?? "");
    expect(reenviadoEm).toBeGreaterThanOrEqual(antesDoReenvio);
    expect(reenviadoEm).toBeLessThanOrEqual(depoisDoReenvio);
    const reenviado = tabelas.automation_rule_runs?.[1];
    expect((reenviado?.actions_result as Array<{ detail?: Linha }>)[0]?.detail).toMatchObject({
      delivery_id: entrega,
      attempt: 2,
      resent_from_run_id: original.id,
    });

    // 3. De novo a partir do MESMO run original: conta os dois runs do par.
    const segundo = await reenviar(original.id as string);
    expect(segundo.status).toBe(201);
    expect(recebidas[2]?.["x-webhook-delivery"]).toBe(entrega);
    expect(recebidas[2]?.["x-webhook-attempt"]).toBe("3");
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "automation.run_resent",
        metadata: expect.objectContaining({ original_run_id: original.id }),
      }),
    );
  });

  it("ação removida antes do Reenviar: a que herda a posição sai com id novo, não com o da removida", async () => {
    // Duas ações IGUAIS para a mesma URL — o pior caso: nem a config as separa.
    const webhook = { type: "call_webhook", config: { url } };
    const regra: Linha = {
      id: REGRA,
      organization_id: ORG,
      trigger_event: "lead.created",
      is_active: true,
      name: "Regra de teste",
      conditions: [],
      actions: [webhook, webhook],
    };
    const tabelas: Record<string, Linha[]> = {
      automation_rules: [regra],
      event_log: [evento()],
      automation_rule_runs: [],
    };
    const banco = bancoFalso(tabelas);
    deps.criarClientDeSessao.mockResolvedValue(banco);
    deps.criarClientAdmin.mockReturnValue(banco);

    await runAutomationForEvent(banco, evento());
    const [daPrimeira, daSegunda] = recebidas.map((r) => r["x-webhook-delivery"]);
    expect(daPrimeira).toBeTypeOf("string");
    expect(daSegunda).toBeTypeOf("string");
    expect(daSegunda).not.toBe(daPrimeira);
    const original = tabelas.automation_rule_runs?.[0];
    if (!original) throw new Error("o motor não gravou o run");

    // O operador remove a primeira para reenviar só a segunda, que vira a posição 0.
    regra.actions = [webhook];
    const resposta = await reenviar(original.id as string);
    expect(resposta.status).toBe(201);
    const doReenvio = recebidas[2]?.["x-webhook-delivery"];
    expect(doReenvio).not.toBe(daPrimeira);
    expect(doReenvio).toBe(idDaEntrega(EVENTO, REGRA, 0, [webhook]));
  });
});
