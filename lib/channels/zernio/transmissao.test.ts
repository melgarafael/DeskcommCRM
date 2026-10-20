import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A transmissão pelo parceiro: o que vai em cada chamada e como o relatório
 * volta. Os corpos de resposta são os da especificação publicada e os da prova
 * real de 16/10/2026 (`cfg/172`), não inventados.
 */

vi.mock("./credentials", async (orig) => ({
  ...(await orig<typeof import("./credentials")>()),
  resolveZernioCreds: vi.fn(async () => ({
    accountId: "acc_1",
    apiKey: "chave-de-teste",
    baseUrl: "https://parceiro.test/api",
    source: "session",
  })),
}));

import { ErroDaTransmissao } from "../transmissao-tipos";
import { destinatarioDoParceiro, transmissaoDoParceiro } from "./transmissao";

const admin = {
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { zernio_account_id: "acc_1" }, error: null }),
    };
    return q;
  },
} as never;

const chamadas: Array<{ metodo: string; url: string; corpo: unknown }> = [];
let respostas: Array<{ status: number; corpo: unknown }> = [];

beforeEach(() => {
  chamadas.length = 0;
  respostas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      chamadas.push({
        metodo: init?.method ?? "GET",
        url: String(url),
        corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = respostas.shift() ?? { status: 200, corpo: { success: true } };
      return new Response(JSON.stringify(r.corpo), { status: r.status });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const CONTAS = {
  status: 200,
  // Medido: `profileId` é um objeto, não um id solto.
  corpo: { accounts: [{ _id: "acc_1", profileId: { _id: "perfil_1", name: "MP AGENCIA" } }] },
};

describe("criar", () => {
  it("manda o modelo com o valor já escrito em `components` e o mesmo valor no mapeamento", async () => {
    respostas = [CONTAS, { status: 200, corpo: { success: true, broadcast: { id: "bc_1", status: "draft" } } }];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    const { id } = await ops.criar({
      nome: "Oferta da Cafeteira",
      modelo: {
        name: "recordatorio_pedido_web",
        language: "pt_BR",
        components: [{ type: "body", parameters: [{ type: "text", text: "Cafeteira Elétrica" }] }],
        valoresDoCorpo: ["Cafeteira Elétrica"],
      },
    });
    expect(id).toBe("bc_1");
    const criar = chamadas[1]!;
    expect(criar.url).toBe("https://parceiro.test/api/v1/broadcasts");
    expect(criar.corpo).toEqual({
      profileId: "perfil_1",
      accountId: "acc_1",
      platform: "whatsapp",
      name: "Oferta da Cafeteira",
      template: {
        name: "recordatorio_pedido_web",
        language: "pt_BR",
        components: [{ type: "body", parameters: [{ type: "text", text: "Cafeteira Elétrica" }] }],
        // Medido: o mapeamento não é aplicado — o texto de `components` é o que
        // sai. Ele vai com o MESMO valor para não dizer outra coisa se um dia for.
        variableMapping: { "1": { field: "custom", customValue: "Cafeteira Elétrica" } },
      },
    });
  });

  it("modelo sem variável vai só com nome e idioma", async () => {
    respostas = [CONTAS, { status: 200, corpo: { success: true, broadcast: { id: "bc_2" } } }];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    await ops.criar({ nome: "x", modelo: { name: "oferta_cafeteira", language: "pt_BR", components: [], valoresDoCorpo: [] } });
    const corpo = chamadas.at(-1)!.corpo as { template: unknown };
    expect(corpo.template).toEqual({ name: "oferta_cafeteira", language: "pt_BR" });
  });
});

describe("adicionar, enviar, ler", () => {
  it("telefones vão em E.164 com o `+`, e o desfecho volta somado", async () => {
    respostas = [{ status: 200, corpo: { success: true, added: 2, skipped: 1 } }];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    const r = await ops.adicionar("bc_1", ["+5511987654321", "5511912345678", "+55 11 90000 0000"]);
    expect(r).toEqual({ adicionados: 2, pulados: 1 });
    expect(chamadas[0]!.url).toBe("https://parceiro.test/api/v1/broadcasts/bc_1/recipients");
    expect(chamadas[0]!.corpo).toEqual({ phones: ["+5511987654321", "+5511912345678", "+5511900000000"] });
  });

  it("o estado que o envio devolve é lido; estado desconhecido é erro, não `completed` inventado", async () => {
    respostas = [
      { status: 200, corpo: { success: true, status: "completed", sent: 2, failed: 0, recipientCount: 2 } },
      { status: 200, corpo: { success: true, broadcast: { id: "bc_1", status: "paused_by_meta" } } },
    ];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    expect(await ops.enviar("bc_1")).toEqual({ estado: "completed" });
    await expect(ops.ler("bc_1")).rejects.toBeInstanceOf(ErroDaTransmissao);
  });

  it("recusa do provedor vira ErroDaTransmissao com o status e o código — 429 é limite de velocidade", async () => {
    respostas = [
      { status: 403, corpo: { error: "Monthly message allowance exceeded", code: "message_allowance_exceeded" } },
      { status: 429, corpo: { error: "Rate limit exceeded" } },
    ];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    const recusa = await ops.enviar("bc_1").catch((e: unknown) => e);
    expect(recusa).toMatchObject({ status: 403, codigo: "message_allowance_exceeded", ehLimiteDeVelocidade: false });
    const limite = await ops.enviar("bc_1").catch((e: unknown) => e);
    expect(limite).toMatchObject({ status: 429, codigo: "http_429", ehLimiteDeVelocidade: true });
  });
});

describe("o relatório por destinatário", () => {
  it("lê a linha como a prova real a trouxe", () => {
    expect(
      destinatarioDoParceiro({
        id: "6ad297966c6c507b49d606a0",
        platformIdentifier: "5511912345678",
        contactName: "+5511912345678",
        status: "delivered",
        messageId: "wamid.HBgMNTk1OTgyNDYxMDE3",
        error: null,
        errorCode: null,
        sentAt: "2026-10-16T21:31:04.508Z",
        deliveredAt: "2026-10-16T21:31:07.000Z",
        readAt: null,
      }),
    ).toEqual({
      telefone: "5511912345678",
      status: "delivered",
      idDaMensagem: "wamid.HBgMNTk1OTgyNDYxMDE3",
      codigoDoErro: null,
      erro: null,
      enviadoEm: "2026-10-16T21:31:04.508Z",
      entregueEm: "2026-10-16T21:31:07.000Z",
      lidoEm: null,
    });
  });

  it("falha traz o código numérico como texto e a explicação na frente da mensagem curta", () => {
    expect(
      destinatarioDoParceiro({
        platformIdentifier: "5511900000000",
        status: "failed",
        errorCode: 131049,
        error: "Message failed",
        errorExplanation: "Meta chose not to deliver this marketing message.",
      }),
    ).toMatchObject({ status: "failed", codigoDoErro: "131049", erro: "Meta chose not to deliver this marketing message." });
  });

  it("linha sem telefone ou com status fora do vocabulário é ignorada", () => {
    expect(destinatarioDoParceiro({ status: "sent" })).toBeNull();
    expect(destinatarioDoParceiro({ platformIdentifier: "5511900000000", status: "queued_somewhere" })).toBeNull();
  });

  it("a página diz quantas linhas vieram — é o que avança `pular`, legíveis ou não", async () => {
    respostas = [
      {
        status: 200,
        corpo: {
          success: true,
          recipients: [{ platformIdentifier: "5511987654321", status: "read" }, { status: "estranho" }],
          pagination: { total: 3, limit: 2, skip: 0, hasMore: true },
        },
      },
    ];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    const p = await ops.destinatarios("bc_1", { pular: 0, quantos: 2 });
    expect(p.lidos).toBe(2);
    expect(p.itens).toHaveLength(1);
    expect(p.temMais).toBe(true);
    expect(chamadas[0]!.url).toBe("https://parceiro.test/api/v1/broadcasts/bc_1/recipients?limit=2&skip=0");
  });
});

describe("cancelar", () => {
  it("400 (já terminou ou nem saiu do rascunho) não é falha de quem cancela", async () => {
    respostas = [{ status: 400, corpo: { error: "Cannot cancel in current status" } }];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    await expect(ops.cancelar("bc_1")).resolves.toBeUndefined();
    expect(chamadas[0]!.url).toBe("https://parceiro.test/api/v1/broadcasts/bc_1/cancel");
  });

  it("outra recusa sobe — a campanha registra que não conseguiu parar o provedor", async () => {
    respostas = [{ status: 500, corpo: { error: "boom" } }];
    const ops = (await transmissaoDoParceiro(admin, { organizationId: "org-1", channelSessionId: "sess-1" }))!;
    await expect(ops.cancelar("bc_1")).rejects.toBeInstanceOf(ErroDaTransmissao);
  });
});
