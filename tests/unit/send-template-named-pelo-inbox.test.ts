import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn() }));

import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";

/**
 * Template `parameter_format = NAMED` pelo caminho do Inbox e da API REST
 * (#2659): os dois chegam por `sendTemplateForSession`, que lia o espelho SEM
 * `parameter_format` — o contrato era derivado como POSITIONAL e a Meta
 * respondia `meta_100: Parameter name is missing or empty`.
 *
 * Duplo espelho, os dois lados medidos: (1) o que PEDIMOS ao espelho (a lista
 * de colunas tem de incluir `parameter_format`) e (2) o que SAI para o
 * provedor (cada parâmetro textual carrega `parameter_name`).
 */
const COMPONENTES_NAMED = [
  { type: "HEADER", format: "TEXT", text: "Olá {{primeiro_nome}}" },
  { type: "BODY", text: "Seu pedido {{pedido_id}} saiu." },
];

function linhaDoEspelho(parameter_format: string) {
  return {
    name: "pedido_saiu",
    language: "pt_BR",
    status: "APPROVED",
    contract_hash: "h",
    parameter_format,
    components: COMPONENTES_NAMED,
  };
}

/** Banco falso: registra as colunas pedidas e devolve a linha do espelho. */
function dbCom(linha: unknown) {
  const colunasPedidas: string[] = [];
  const db = {
    from: () => {
      const q = {
        select: (cols: string) => {
          colunasPedidas.push(cols);
          return q;
        },
        eq: () => q,
        maybeSingle: async () => ({ data: linha, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, colunasPedidas };
}

const ENVIO = {
  organizationId: "org-1",
  sessionRef: "PN",
  to: "5531999998888",
  name: "pedido_saiu",
  language: "pt_BR",
  values: { "header:primeiro_nome": "João", pedido_id: "DESK-001" },
  channelSessionId: "sess-1",
};

function stubFetchComId(id: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 }));
}

function corpoEnviado(fetchSpy: ReturnType<typeof stubFetchComId>) {
  const [, init] = fetchSpy.mock.calls.at(-1)!;
  return JSON.parse(init?.body as string) as {
    template: { components: { type: string; parameters: unknown[] }[] };
  };
}

beforeEach(() => {
  vi.mocked(resolveMetaCreds).mockReset();
  vi.mocked(resolveMetaCreds).mockResolvedValue({
    phoneNumberId: "PN",
    token: "tok",
    graphVersion: "v22.0",
    source: "session",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("template NAMED pelo caminho do Inbox e da API (#2659)", () => {
  it("lê parameter_format do espelho — sem ele o contrato vira POSITIONAL", async () => {
    stubFetchComId("wamid.N");
    const { db, colunasPedidas } = dbCom(linhaDoEspelho("NAMED"));
    await sendTemplateForSession(db, ENVIO);
    expect(colunasPedidas.join(" ")).toContain("parameter_format");
  });

  it("cada parâmetro textual que sai para a Meta carrega parameter_name", async () => {
    const fetchSpy = stubFetchComId("wamid.N");
    const { db } = dbCom(linhaDoEspelho("NAMED"));

    expect(await sendTemplateForSession(db, ENVIO)).toBe("wamid.N");

    expect(corpoEnviado(fetchSpy).template.components).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", parameter_name: "primeiro_nome", text: "João" }],
      },
      {
        type: "body",
        parameters: [{ type: "text", parameter_name: "pedido_id", text: "DESK-001" }],
      },
    ]);
  });

  it("espelho POSITIONAL continua sem parameter_name no payload", async () => {
    const fetchSpy = stubFetchComId("wamid.P");
    const { db } = dbCom(linhaDoEspelho("POSITIONAL"));

    await sendTemplateForSession(db, ENVIO);

    // A linha do espelho é a MESMA, menos o formato — é o único eixo que muda.
    expect(corpoEnviado(fetchSpy).template.components).toEqual([
      { type: "header", parameters: [{ type: "text", text: "João" }] },
      { type: "body", parameters: [{ type: "text", text: "DESK-001" }] },
    ]);
  });
});
