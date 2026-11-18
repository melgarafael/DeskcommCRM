/**
 * `conexao-pela-instalacao` — o que a conexão por um clique pede ao provedor.
 *
 * O que este arquivo prova, com o provedor DUBLADO (nada de rede):
 *   1. o perfil da organização é reaproveitado (gravado ou pelo nome) e um 409
 *      na criação converge para o perfil que já existe, sem criar outro;
 *   2. a página de conexão é a HOSPEDADA, no idioma da organização, com a tela
 *      da Meta escolhida (coexistência ou só nuvem) e a cor só quando é válida;
 *   3. a conta da volta só vale se estiver NO PERFIL, for de WhatsApp e ativa;
 *   4. o webhook da CHAVE PRÓPRIA nasce filtrado à conta, e o achado pela URL
 *      recebe o filtro em vez de virar uma segunda assinatura (o do um clique é
 *      o único da instalação: `webhook-da-instalacao.test.ts`);
 *   5. apagar converge no 404 e lança em qualquer outra falha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./credentials", () => ({ zernioBaseUrl: () => "https://zernio.test" }));

import {
  EVENTOS_DO_WEBHOOK,
  apagarWebhook,
  contaConectadaNoPerfil,
  contaEstaNoPerfil,
  desconectarConta,
  garantirPerfil,
  garantirWebhook,
  motivoDaVolta,
  nomeDoPerfil,
  urlDaPaginaDeConexao,
  whatsappDoPerfil,
} from "./conexao-pela-instalacao";

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: unknown;
}
let chamadas: Chamada[] = [];
let respostas: Array<(c: Chamada) => { status: number; body?: unknown } | undefined> = [];

/** A n-ésima chamada ao provedor — lança se ela não aconteceu, em vez de seguir com `undefined`. */
function chamada(n: number): Chamada {
  const c = chamadas[n];
  if (!c) throw new Error(`a chamada ${n} ao provedor não aconteceu`);
  return c;
}

function responder(fn: (c: Chamada) => { status: number; body?: unknown } | undefined) {
  respostas.push(fn);
}

beforeEach(() => {
  chamadas = [];
  respostas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c: Chamada = {
        metodo: init.method ?? "GET",
        caminho: url.replace("https://zernio.test/v1/", ""),
        corpo: init.body ? JSON.parse(init.body as string) : undefined,
      };
      chamadas.push(c);
      for (const r of respostas) {
        const res = r(c);
        if (res)
          return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
            status: res.status,
          });
      }
      return new Response(JSON.stringify({ erro: "sem dublê" }), { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const ORG = { id: "0f1e2d3c-aaaa-bbbb-cccc-000000000001", nome: "Loja da Ana" };
const PERFIL = "a".repeat(24);
const CONTA = "b".repeat(24);

describe("garantirPerfil", () => {
  it("reaproveita o perfil gravado sem criar outro", async () => {
    responder((c) =>
      c.metodo === "GET" && c.caminho === "profiles"
        ? { status: 200, body: { profiles: [{ _id: PERFIL, name: "x" }] } }
        : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, perfilGravado: PERFIL })).toBe(PERFIL);
    expect(chamadas.filter((c) => c.metodo === "POST")).toHaveLength(0);
  });

  it("acha pelo nome o perfil que uma tentativa anterior criou", async () => {
    responder((c) =>
      c.metodo === "GET"
        ? { status: 200, body: { profiles: [{ _id: PERFIL, name: nomeDoPerfil(ORG) }] } }
        : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, perfilGravado: null })).toBe(PERFIL);
    expect(chamadas.filter((c) => c.metodo === "POST")).toHaveLength(0);
  });

  it("organização renomeada (ou marca trocada) reaproveita o perfil pelo id, sem criar outro", async () => {
    responder((c) =>
      c.metodo === "GET"
        ? {
            status: 200,
            body: { profiles: [{ _id: PERFIL, name: `Marca Velha · Nome Antigo · ${ORG.id}` }] },
          }
        : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, marca: "Marca Nova", perfilGravado: null })).toBe(
      PERFIL,
    );
    expect(chamadas.filter((c) => c.metodo === "POST")).toHaveLength(0);
  });

  it("perfil de OUTRA organização com o mesmo começo de id não é reaproveitado", async () => {
    const vizinha = `${ORG.id.slice(0, 8)}-ffff-ffff-ffff-000000000009`;
    responder((c) =>
      c.metodo === "GET"
        ? { status: 200, body: { profiles: [{ _id: "c".repeat(24), name: `Loja da Ana · ${vizinha}` }] } }
        : undefined,
    );
    responder((c) =>
      c.metodo === "POST" ? { status: 201, body: { profile: { _id: PERFIL } } } : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, perfilGravado: null })).toBe(PERFIL);
  });

  it("cria com o nome da organização e o id inteiro dela no fim", async () => {
    responder((c) => (c.metodo === "GET" ? { status: 200, body: { profiles: [] } } : undefined));
    responder((c) =>
      c.metodo === "POST" ? { status: 201, body: { profile: { _id: PERFIL } } } : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, perfilGravado: null })).toBe(PERFIL);
    expect(chamadas.find((c) => c.metodo === "POST")?.corpo).toEqual({
      name: `Loja da Ana · ${ORG.id}`,
    });
  });

  it("com marca própria, a marca da INSTALAÇÃO vem na frente — o perfil não se confunde com o de outro sistema na mesma conta", async () => {
    responder((c) => (c.metodo === "GET" ? { status: 200, body: { profiles: [] } } : undefined));
    responder((c) =>
      c.metodo === "POST" ? { status: 201, body: { profile: { _id: PERFIL } } } : undefined,
    );
    await garantirPerfil("k", { ...ORG, marca: "  Marca   Exemplo ", perfilGravado: null });
    expect(chamadas.find((c) => c.metodo === "POST")?.corpo).toEqual({
      name: `Marca Exemplo · Loja da Ana · ${ORG.id}`,
    });
  });

  it("marca e nome longos são cortados; sem marca, o formato sem prefixo", () => {
    const nome = nomeDoPerfil({ id: ORG.id, nome: "N".repeat(80), marca: "M".repeat(80) });
    expect(nome).toBe(`${"M".repeat(30)} · ${"N".repeat(40)} · ${ORG.id}`);
    expect(nomeDoPerfil({ ...ORG, marca: null })).toBe(`Loja da Ana · ${ORG.id}`);
    expect(nomeDoPerfil({ ...ORG, marca: "   " })).toBe(`Loja da Ana · ${ORG.id}`);
  });

  it("409 na criação converge para o perfil que já existe", async () => {
    let listas = 0;
    responder((c) =>
      c.metodo === "GET"
        ? {
            status: 200,
            body: { profiles: listas++ === 0 ? [] : [{ _id: PERFIL, name: nomeDoPerfil(ORG) }] },
          }
        : undefined,
    );
    responder((c) =>
      c.metodo === "POST" ? { status: 409, body: { error: "duplicado" } } : undefined,
    );
    expect(await garantirPerfil("k", { ...ORG, perfilGravado: null })).toBe(PERFIL);
  });
});

describe("urlDaPaginaDeConexao", () => {
  const base = {
    profileId: PERFIL,
    redirectUrl: "https://crm.exemplo.com/auth/partner-return/estado",
    coexistencia: true,
    marca: "Marca Exemplo",
    cor: "#206ce8",
    idioma: "es-PY",
  };

  it("pede a página hospedada, em espanhol, com a tela de coexistência", async () => {
    responder(() => ({
      status: 200,
      body: { authUrl: "https://zernio.test/connect/whatsapp/embedded-signup?x=1", state: "s" },
    }));
    expect(await urlDaPaginaDeConexao("k", base)).toBe(
      "https://zernio.test/connect/whatsapp/embedded-signup?x=1",
    );
    const q = new URLSearchParams(chamada(0).caminho.split("?")[1]);
    expect(chamada(0).caminho.startsWith("connect/whatsapp?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({
      profileId: PERFIL,
      redirect_url: base.redirectUrl,
      onboarding: "business_app",
      signup: "hosted",
      brandName: "Marca Exemplo",
      language: "es",
      primaryColor: "#206ce8",
    });
  });

  it("número só na nuvem pede `api`; cor inválida fica de fora", async () => {
    responder(() => ({ status: 200, body: { authUrl: "https://zernio.test/x" } }));
    await urlDaPaginaDeConexao("k", { ...base, coexistencia: false, cor: "azul", idioma: "pt-BR" });
    const q = new URLSearchParams(chamada(0).caminho.split("?")[1]);
    expect(q.get("onboarding")).toBe("api");
    expect(q.get("language")).toBe("pt-BR");
    expect(q.has("primaryColor")).toBe(false);
  });

  it("aceita http só na própria máquina (o dublê das provas de tela)", async () => {
    responder(() => ({ status: 200, body: { authUrl: "http://127.0.0.1:3996/cadastro" } }));
    expect(await urlDaPaginaDeConexao("k", base)).toBe("http://127.0.0.1:3996/cadastro");
  });

  it("recusa endereço que não é https", async () => {
    responder(() => ({ status: 200, body: { authUrl: "http://zernio.test/x" } }));
    await expect(urlDaPaginaDeConexao("k", base)).rejects.toThrow("inseguro");
  });
});

describe("whatsappDoPerfil", () => {
  it("devolve o WhatsApp ativo que o perfil já tem, e null quando não tem", async () => {
    responder(() => ({
      status: 200,
      body: {
        accounts: [
          { _id: "c".repeat(24), platform: "instagram", isActive: true, profileId: PERFIL },
          {
            _id: CONTA,
            platform: "whatsapp",
            username: "+1 310 555 1234",
            isActive: true,
            profileId: { _id: PERFIL },
          },
        ],
      },
    }));
    expect(await whatsappDoPerfil("k", PERFIL)).toEqual({
      accountId: CONTA,
      telefone: "+13105551234",
      nome: null,
    });
    respostas = [];
    responder(() => ({ status: 200, body: { accounts: [] } }));
    expect(await whatsappDoPerfil("k", PERFIL)).toBeNull();
  });
});

describe("contaConectadaNoPerfil", () => {
  const conta = {
    _id: CONTA,
    platform: "whatsapp",
    username: "+55 11 98765 0000",
    displayName: "Loja",
    isActive: true,
    profileId: PERFIL,
  };

  it("conta do perfil, de WhatsApp e ativa: devolve o telefone em E.164", async () => {
    responder(() => ({ status: 200, body: { accounts: [conta] } }));
    expect(await contaConectadaNoPerfil("k", PERFIL, CONTA)).toEqual({
      accountId: CONTA,
      telefone: "+5511987650000",
      nome: "Loja",
    });
    expect(chamada(0).caminho).toBe(`accounts?profileId=${PERFIL}`);
  });

  it.each([
    ["de outro perfil", { profileId: "c".repeat(24) }],
    ["de outra rede", { platform: "instagram" }],
    ["inativa", { isActive: false }],
    ["com outro id", { _id: "d".repeat(24) }],
  ])("conta %s não vale", async (_nome, troca) => {
    responder(() => ({ status: 200, body: { accounts: [{ ...conta, ...troca }] } }));
    expect(await contaConectadaNoPerfil("k", PERFIL, CONTA)).toBeNull();
  });
});

describe("contaEstaNoPerfil", () => {
  it("só vale a conta que o provedor lista NESTE perfil — ativa ou não", async () => {
    responder(() => ({
      status: 200,
      body: {
        accounts: [
          { _id: CONTA, platform: "whatsapp", isActive: false, profileId: PERFIL },
          { _id: "d".repeat(24), platform: "whatsapp", isActive: true, profileId: "e".repeat(24) },
        ],
      },
    }));
    expect(await contaEstaNoPerfil("k", PERFIL, CONTA)).toBe(true);
    expect(chamada(0).caminho).toBe(`accounts?profileId=${PERFIL}`);
    expect(await contaEstaNoPerfil("k", PERFIL, "d".repeat(24))).toBe(false);
  });
});

describe("garantirWebhook", () => {
  const w = {
    url: "https://crm.exemplo.com/api/v1/webhooks/channel/tok",
    segredo: "s3gr3d0",
    segredoNovo: false,
    accountId: CONTA,
    nome: "CRM WhatsApp",
  };

  it("cria a assinatura filtrada à conta, com segredo e os eventos do número", async () => {
    responder((c) =>
      c.metodo === "GET"
        ? {
            status: 200,
            body: { webhooks: [{ _id: "w-outro", url: "https://outro/x", isActive: true }] },
          }
        : undefined,
    );
    responder((c) =>
      c.metodo === "POST" ? { status: 200, body: { webhook: { _id: "w-novo" } } } : undefined,
    );
    expect(await garantirWebhook("k", w)).toBe("w-novo");
    expect(chamadas.find((c) => c.metodo === "POST")?.corpo).toEqual({
      name: "CRM WhatsApp",
      url: w.url,
      secret: "s3gr3d0",
      events: [...EVENTOS_DO_WEBHOOK],
      accountIds: [CONTA],
      isActive: true,
    });
  });

  it("achada pela URL com segredo NOVO: a velha sai e nasce uma com o segredo novo", async () => {
    responder((c) =>
      c.metodo === "GET"
        ? { status: 200, body: { webhooks: [{ _id: "w-velho", url: w.url, isActive: true }] } }
        : undefined,
    );
    responder((c) => (c.metodo === "DELETE" ? { status: 200, body: {} } : undefined));
    responder((c) =>
      c.metodo === "POST" ? { status: 200, body: { webhook: { _id: "w-novo" } } } : undefined,
    );
    expect(await garantirWebhook("k", { ...w, segredoNovo: true })).toBe("w-novo");
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET", "DELETE", "POST"]);
    expect(chamada(1).caminho).toBe("webhooks/settings?webhookId=w-velho");
    expect((chamada(2).corpo as { secret: string }).secret).toBe("s3gr3d0");
  });

  it("a assinatura achada pela URL com o mesmo segredo recebe o filtro e é religada, sem criar outra", async () => {
    responder((c) =>
      c.metodo === "GET"
        ? { status: 200, body: { webhooks: [{ _id: "w-velho", url: w.url, isActive: false }] } }
        : undefined,
    );
    responder((c) => (c.metodo === "PUT" ? { status: 200, body: {} } : undefined));
    expect(await garantirWebhook("k", w)).toBe("w-velho");
    expect(chamadas.filter((c) => c.metodo === "POST")).toHaveLength(0);
    expect(chamadas.find((c) => c.metodo === "PUT")?.corpo).toEqual({
      webhookId: "w-velho",
      accountIds: [CONTA],
      isActive: true,
    });
  });
});

describe("apagar no provedor", () => {
  it("404 converge", async () => {
    responder(() => ({ status: 404, body: { error: "not found" } }));
    await expect(apagarWebhook("k", "w1")).resolves.toBeUndefined();
    await expect(desconectarConta("k", CONTA)).resolves.toBeUndefined();
    expect(chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual([
      "DELETE webhooks/settings?webhookId=w1",
      `DELETE accounts/${CONTA}`,
    ]);
  });

  it("outra falha lança: a remoção pode ser tentada de novo", async () => {
    responder(() => ({ status: 500, body: {} }));
    await expect(desconectarConta("k", CONTA)).rejects.toThrow();
  });
});

describe("motivoDaVolta", () => {
  it("traduz os códigos da volta e cai no genérico para o desconhecido", () => {
    expect(motivoDaVolta("connection_cancelled")).toContain("cancelada");
    expect(motivoDaVolta("payment_required")).toContain("meio de pagamento");
    expect(motivoDaVolta("one_whatsapp_per_profile")).toContain("já tem um número");
    expect(motivoDaVolta("xyz")).toBe(motivoDaVolta(null));
  });
});
