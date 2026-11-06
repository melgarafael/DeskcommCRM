import { describe, expect, it, vi } from "vitest";

import { ErroDoProvedor, type AdaptadorDeCobranca } from "./contrato";
import {
  criarAdaptadorEfi,
  credencialDaChave,
  dataCivilEmSaoPaulo,
  erroDoEfi,
  fimDoDiaEmSaoPaulo,
  modoDaChaveEfi,
  verificarWebhookEfi,
  JANELA_DO_AVISO_MS,
  type CredencialDoEfi,
  type DependenciasDoEfi,
} from "./efi";

/**
 * O ADAPTADOR DO EFI BANK (issue #4056), contra um Efi de mentira que responde
 * na forma REAL da API de Cobranças (dev.efipay.com.br/docs/api-cobrancas) e
 * respeita o que o adaptador depende: OAuth2 em `/v1/authorize`, plano por
 * nome, link de assinatura, link de cobrança avulsa, leitura de assinatura e
 * lista de cobranças por `custom_id`. Nenhuma chamada real.
 */

const CLIENTE_ID = "9f1c2a7e3b4d4e5f8a9b0c1d2e3f4a5b";
const SEGREDO_DO_CLIENTE = "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const CREDENCIAL = `teste:${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}`;
const MARCA = "a1b2c3d4e5f60718";
const SEGREDO_DO_AVISO = "token-do-aviso-do-efi-000000000000000";
const TOKEN_DA_API = "access-token-do-efi-0000000000000000";
const ORG = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const OUTRA_ORG = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REF = `org:${ORG}`;
/** 12:00 em São Paulo: "hoje" é 2026-10-05. */
const AGORA = new Date("2026-10-05T15:00:00Z");
const APP = "https://crm.example.com";
const PLANO = { id: "plano-1", nome: "CRM Pro", precoCents: 14990, intervalo: "mes" as const };

type Resposta = { status?: number; corpo?: unknown; headers?: Record<string, string> } | "rede_caiu" | "sem_corpo";
type Responder = Resposta | Resposta[] | ((url: URL, corpo: unknown) => Resposta);
type Chamada = { rota: string; url: URL; headers: Headers; corpo: unknown };

/** Rota = "MÉTODO /v1/caminho" sem query. Lista = fila (a última se repete). Rota não declarada → 404. */
function efiFalso(rotas: Record<string, Responder>) {
  const filas = new Map<string, Responder>(Object.entries(rotas).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const chamadas: Chamada[] = [];
  const fetchFalso: typeof fetch = async (entrada, init) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
    const rota = `${init?.method ?? "GET"} ${url.pathname}`;
    const corpo: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    chamadas.push({ rota, url, headers: new Headers(init?.headers), corpo });
    const r = filas.get(rota);
    const resposta = typeof r === "function" ? r(url, corpo) : Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r;
    if (resposta === undefined) return Response.json({ error: "rota_nao_declarada" }, { status: 404 });
    if (resposta === "rede_caiu") throw new TypeError("fetch failed");
    if (resposta === "sem_corpo") return new Response(null, { status: resposta === "sem_corpo" ? 200 : 500 });
    return Response.json(resposta.corpo ?? {}, { status: resposta.status ?? 200, headers: resposta.headers });
  };
  return { fetchFalso, chamadas };
}

function montar(rotas: Record<string, Responder>, extra: Partial<DependenciasDoEfi> = {}) {
  const { fetchFalso, chamadas } = efiFalso({ "POST /v1/authorize": { corpo: { access_token: TOKEN_DA_API, expires_in: 600 } }, ...rotas });
  const esperas: number[] = [];
  const adaptador = criarAdaptadorEfi({
    lerChave: async () => CREDENCIAL,
    fetch: fetchFalso,
    // Loopback: só credencial de TESTE chega aqui, como no dublê do e2e.
    baseUrl: "http://127.0.0.1:3995",
    esperar: async (ms) => {
      esperas.push(ms);
    },
    agora: () => AGORA,
    marca: MARCA,
    urlPublica: APP,
    lerSegredo: async () => SEGREDO_DO_AVISO,
    ...extra,
  });
  return { adaptador, chamadas, esperas };
}

const PLANO_CRIADO = { corpo: { code: 200, data: { plan_id: 55 } } };
const PLANO_EXISTENTE = { corpo: { code: 200, data: [{ plan_id: 55, name: "CRM CRM Pro mes 14990" }] } };
const LINK_DA_ASSINATURA = {
  corpo: {
    code: 200,
    data: {
      subscription_id: 8021,
      status: "new",
      payment_url: "https://pagamento.gerencianet.com.br/abc",
      expire_at: "2026-10-12",
      charge: { id: 371496106, status: "link" },
    },
  },
};
const ROTA_DO_LINK = "POST /v1/plan/55/subscription/one-step/link";
const ROTA_DAS_COBRANCAS = "GET /v1/charges";

const assinaturaLida = (extra: Record<string, unknown> = {}) => ({
  corpo: {
    code: 200,
    data: {
      subscription_id: 8021,
      value: 14990,
      status: "active",
      next_expire_at: "2026-11-05",
      plan: { interval: 1, repeats: null },
      history: [
        { charge_id: 1, status: "new", created_at: "2026-10-05 09:00:00" },
        { charge_id: 1, status: "paid", created_at: "2026-10-05 09:10:00" },
      ],
      ...extra,
    },
  },
});

describe("a credencial do Efi", () => {
  it("⭐ o modo sai do que a tela gravou: cliente e segredo nunca são adivinhados", () => {
    expect(modoDaChaveEfi(CREDENCIAL)).toBe("teste");
    expect(modoDaChaveEfi(`producao:${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}`)).toBe("producao");
    expect(credencialDaChave(CREDENCIAL)).toEqual<CredencialDoEfi>({ modo: "teste", clientId: CLIENTE_ID, clientSecret: SEGREDO_DO_CLIENTE });
  });

  it.each(["", "sem-formato", `${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}`, "sandbox:abc:def", "teste:curto:curto"])(
    "credencial fora do formato recusada: %s",
    (chave) => {
      expect(modoDaChaveEfi(chave)).toBeNull();
      expect(credencialDaChave(chave)).toBeNull();
    },
  );
});

describe("o transporte do Efi", () => {
  it("⭐ a credencial vai só no Basic do /authorize e o token só no Bearer — nunca na URL", async () => {
    const { adaptador, chamadas } = montar({ "GET /v1/subscription/8021": assinaturaLida() });
    await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    const [autorizacao, leitura] = chamadas;
    expect(autorizacao?.rota).toBe("POST /v1/authorize");
    expect(autorizacao?.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}`).toString("base64")}`);
    expect(autorizacao?.corpo).toEqual({ grant_type: "client_credentials" });
    expect(leitura?.headers.get("authorization")).toBe(`Bearer ${TOKEN_DA_API}`);
    expect(leitura?.headers.get("user-agent")).toBe(`cobranca-do-revendedor/${MARCA}`);
    for (const c of chamadas) {
      expect(c.url.toString()).not.toContain(SEGREDO_DO_CLIENTE);
      expect(JSON.stringify(c.corpo ?? {})).not.toContain(SEGREDO_DO_CLIENTE);
    }
  });

  it("o token é reaproveitado entre chamadas (uma autorização por processo)", async () => {
    const { adaptador, chamadas } = montar({ "GET /v1/subscription/8021": assinaturaLida() });
    await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    expect(chamadas.filter((c) => c.rota === "POST /v1/authorize")).toHaveLength(1);
  });

  it("⭐ GET repete em 5xx, POST não repete em 5xx (a cobrança pode ter sido criada)", async () => {
    const { adaptador, chamadas, esperas } = montar({
      "GET /v1/subscription/8021": [{ status: 503, corpo: {} }, assinaturaLida()],
      "GET /v1/plans": { corpo: { code: 200, data: [] } },
      "POST /v1/plan": { status: 502, corpo: {} },
      [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } },
    });
    await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    expect(chamadas.filter((c) => c.rota === "GET /v1/subscription/8021")).toHaveLength(2);
    expect(esperas).toHaveLength(1);

    const antes = chamadas.length;
    const erro = await adaptador.iniciarAssinatura({ clienteRef: REF, orgId: ORG, plano: PLANO, trialAte: null, urlDeVolta: "https://x", chaveIdempotencia: "k1" }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect(chamadas.slice(antes).filter((c) => c.rota === "POST /v1/plan")).toHaveLength(1);
  });

  it("429 repete o POST: é recusa antes de processar", async () => {
    const { adaptador, chamadas } = montar({
      "GET /v1/plans": { corpo: { code: 200, data: [] } },
      "POST /v1/plan": [{ status: 429, corpo: { error: "rate_limit" } }, PLANO_CRIADO],
      [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } },
      [ROTA_DO_LINK]: LINK_DA_ASSINATURA,
    });
    const { assinaturaRef } = await adaptador.iniciarAssinatura({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      trialAte: null,
      urlDeVolta: "https://x",
      chaveIdempotencia: "k1",
    });
    expect(assinaturaRef).toBe("8021");
    expect(chamadas.filter((c) => c.rota === "POST /v1/plan")).toHaveLength(2);
  });

  it("⭐ 401 no /authorize vira credencial_invalida, e a mensagem não carrega a chave", async () => {
    const { adaptador } = montar({ "POST /v1/authorize": { status: 401, corpo: { error: "invalid_client" } } });
    const erro = await adaptador.iniciarAssinatura({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      trialAte: null,
      urlDeVolta: "https://x",
      chaveIdempotencia: "k1",
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect((erro as ErroDoProvedor).credencialInvalida).toBe(true);
    expect((erro as ErroDoProvedor).message).toBe("provedor 401 chave_invalida");
    expect((erro as ErroDoProvedor).message).not.toContain(SEGREDO_DO_CLIENTE);
    expect((erro as ErroDoProvedor).message).not.toContain(CLIENTE_ID);
  });

  it("o texto livre do provedor nunca vira código de erro (o `error_description` ecoa dado)", () => {
    const erro = erroDoEfi(422, { error: "invalid_action", error_description: `cpf 123 do cliente ${SEGREDO_DO_CLIENTE}` });
    expect(erro.codigo).toBe("invalid_action");
    expect(erro.message).not.toContain("cpf");
  });
});

describe("testar a chave do Efi", () => {
  it("⭐ credencial de homologação autentica no /authorize", async () => {
    const { adaptador, chamadas } = montar({});
    expect(await adaptador.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(chamadas.map((c) => c.rota)).toEqual(["POST /v1/authorize"]);
  });

  it("modo exigido diferente da credencial é recusado ANTES de enviar", async () => {
    const { adaptador, chamadas } = montar({});
    expect(await adaptador.testarChave({ modoExigido: "producao" })).toEqual({ ok: false, motivo: "modo_divergente", modo: "teste" });
    expect(chamadas).toEqual([]);
  });

  it("credencial de produção nunca vai ao dublê em loopback", async () => {
    const { adaptador, chamadas } = montar(
      {},
      { lerChave: async () => `producao:${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}` },
    );
    expect(await adaptador.testarChave()).toEqual({ ok: false, motivo: "modo_divergente", modo: "producao" });
    expect(chamadas).toEqual([]);
  });

  it("401 → chave_invalida; 403 → sem_permissao; 5xx → provedor_fora", async () => {
    for (const [status, motivo] of [
      [401, "chave_invalida"],
      [403, "sem_permissao"],
      [503, "provedor_fora"],
    ] as const) {
      const { adaptador } = montar({ "POST /v1/authorize": { status, corpo: { error: "x" } } });
      expect(await adaptador.testarChave()).toEqual({ ok: false, motivo });
    }
  });

  it("sem credencial gravada não há chamada de rede", async () => {
    const { adaptador, chamadas } = montar({}, { lerChave: async () => null });
    expect(await adaptador.testarChave()).toEqual({ ok: false, motivo: "chave_invalida" });
    expect(chamadas).toEqual([]);
  });
});

describe("criar a assinatura no Efi", () => {
  it("⭐ o valor vem do SERVIDOR e o aviso viaja com empresa e token", async () => {
    const { adaptador, chamadas } = montar({
      "GET /v1/plans": { corpo: { code: 200, data: [] } },
      "POST /v1/plan": PLANO_CRIADO,
      [ROTA_DO_LINK]: LINK_DA_ASSINATURA,
      [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } },
    });
    const inicio = await adaptador.iniciarAssinatura({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      trialAte: null,
      urlDeVolta: "https://crm.example.com/app",
      chaveIdempotencia: "k1",
    });
    expect(inicio).toEqual({
      url: "https://pagamento.gerencianet.com.br/abc",
      expiraEm: fimDoDiaEmSaoPaulo("2026-10-12"),
      assinaturaRef: "8021",
      sessaoId: "371496106",
    });
    const plano = chamadas.find((c) => c.rota === "POST /v1/plan");
    expect(plano?.corpo).toMatchObject({ interval: 1, repeats: null });
    const link = chamadas.find((c) => c.rota === ROTA_DO_LINK);
    expect(link?.corpo).toMatchObject({
      items: [{ name: "CRM Pro", value: 14990, amount: 1 }],
      settings: { payment_method: "all" },
    });
    // Moeda não é campo do Efi (só BRL) e o corpo não tem como renegociar preço.
    expect(JSON.stringify(link?.corpo)).not.toContain("currency");
    const aviso = new URLOrNull((link?.corpo as { metadata: { notification_url: string } }).metadata.notification_url);
    expect(aviso.url?.searchParams.get("org")).toBe(REF);
    expect(aviso.url?.searchParams.get("token")).toBe(SEGREDO_DO_AVISO);
    expect(aviso.url?.pathname).toBe("/api/v1/webhooks/cobranca/efi");
  });

  it("reusa o plano do mesmo preço e ciclo em vez de criar um por checkout", async () => {
    const { adaptador, chamadas } = montar({
      "GET /v1/plans": PLANO_EXISTENTE,
      [ROTA_DO_LINK]: LINK_DA_ASSINATURA,
      [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } },
    });
    await adaptador.iniciarAssinatura({ clienteRef: REF, orgId: ORG, plano: PLANO, trialAte: null, urlDeVolta: "https://x", chaveIdempotencia: "k1" });
    expect(chamadas.some((c) => c.rota === "POST /v1/plan")).toBe(false);
  });

  it("⭐ cobrança em aberto da MESMA empresa é reaproveitada: nenhuma segunda cobrança", async () => {
    const { adaptador, chamadas } = montar({
      [ROTA_DAS_COBRANCAS]: {
        corpo: {
          code: 200,
          data: [
            {
              id: 700029856,
              total: 14990,
              status: "waiting",
              custom_id: ORG,
              payment: { payment_method: "banking_billet", banking_billet: { link: "https://visualizacao.gerencianet.com.br/emissao/1", expire_at: "2026-10-10" } },
            },
          ],
        },
      },
    });
    const inicio = await adaptador.iniciarAssinatura({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      trialAte: null,
      urlDeVolta: "https://x",
      chaveIdempotencia: "k1",
    });
    expect(inicio.url).toBe("https://visualizacao.gerencianet.com.br/emissao/1");
    expect(inicio.sessaoId).toBe("700029856");
    expect(chamadas.some((c) => c.rota === ROTA_DO_LINK)).toBe(false);
  });

  it("referência que não é da casa é recusada antes de qualquer chamada", async () => {
    const { adaptador, chamadas } = montar({});
    await expect(
      adaptador.iniciarAssinatura({ clienteRef: "cus_123", orgId: ORG, plano: PLANO, trialAte: null, urlDeVolta: "https://x", chaveIdempotencia: "k1" }),
    ).rejects.toBeInstanceOf(ErroDoProvedor);
    expect(chamadas).toEqual([]);
  });

  it("sem segredo do aviso a cobrança nasce sem notification_url (a reconciliação cura)", async () => {
    const { adaptador, chamadas } = montar(
      { "GET /v1/plans": PLANO_EXISTENTE, [ROTA_DO_LINK]: LINK_DA_ASSINATURA, [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } } },
      { lerSegredo: async () => null },
    );
    await adaptador.iniciarAssinatura({ clienteRef: REF, orgId: ORG, plano: PLANO, trialAte: null, urlDeVolta: "https://x", chaveIdempotencia: "k1" });
    const link = chamadas.find((c) => c.rota === ROTA_DO_LINK);
    expect((link?.corpo as { metadata: Record<string, unknown> }).metadata).toEqual({ custom_id: ORG });
  });
});

describe("o ajuste proporcional", () => {
  it("⭐ cria link de cobrança avulsa com o valor do servidor e reusa o mesmo ajuste", async () => {
    const aberta = {
      corpo: {
        code: 200,
        data: [
          {
            id: 900,
            total: 5000,
            status: "waiting",
            custom_id: `upgrade:${ORG}:k1`,
            payment: { banking_billet: { link: "https://visualizacao.gerencianet.com.br/emissao/2", expire_at: "2026-10-10" } },
          },
        ],
      },
    };
    const { adaptador, chamadas } = montar({ [ROTA_DAS_COBRANCAS]: aberta });
    const ajuste = await adaptador.iniciarAjusteProporcional({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      valorCents: 5000,
      chaveIdempotencia: "k1",
      urlDeVolta: "https://x",
    });
    expect(ajuste).toEqual({ pagamentoRef: "900", url: "https://visualizacao.gerencianet.com.br/emissao/2" });
    expect(chamadas.some((c) => c.rota === "POST /v1/charge/one-step/link")).toBe(false);
    expect(chamadas.find((c) => c.rota === ROTA_DAS_COBRANCAS)?.url.searchParams.get("custom_id")).toBe(`upgrade:${ORG}:k1`);
  });

  it("sem cobrança em aberto, cria o link com o valor que veio do plano", async () => {
    const { adaptador, chamadas } = montar({
      [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } },
      "POST /v1/charge/one-step/link": {
        corpo: { code: 200, data: { charge_id: 901, status: "link", payment_url: "https://pagamento.gerencianet.com.br/def" } },
      },
    });
    const ajuste = await adaptador.iniciarAjusteProporcional({
      clienteRef: REF,
      orgId: ORG,
      plano: PLANO,
      valorCents: 5000,
      chaveIdempotencia: "k1",
      urlDeVolta: "https://x",
    });
    expect(ajuste.pagamentoRef).toBe("901");
    const criada = chamadas.find((c) => c.rota === "POST /v1/charge/one-step/link");
    expect((criada?.corpo as { items: Array<{ value: number }> }).items[0]?.value).toBe(5000);
  });

  it("lê o pagamento avulso: pago, pendente e encerrado", async () => {
    for (const [status, esperado] of [
      ["paid", "pago"],
      ["waiting", "pendente"],
      ["canceled", "encerrado"],
    ] as const) {
      const { adaptador } = montar({ "GET /v1/charge/901": { corpo: { code: 200, data: { id: 901, status } } } });
      expect(await adaptador.lerPagamentoProporcional("901")).toBe(esperado);
    }
  });
});

describe("a leitura do estado", () => {
  it("⭐ pela assinatura: paga, ativa, com o preço do provedor em centavos", async () => {
    const { adaptador, chamadas } = montar({ "GET /v1/subscription/8021": assinaturaLida() });
    const s = await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    expect(s).toMatchObject({
      assinaturaRef: "8021",
      existe: true,
      assinaturasVivas: 1,
      cancelada: false,
      emAtraso: false,
      jaPagou: true,
      precoCents: 14990,
      cancelaNoFim: false,
      emTesteNoProvedorAte: null,
    });
    expect(s.proximoVencimento?.toISOString()).toBe(fimDoDiaEmSaoPaulo("2026-11-05")?.toISOString());
    expect(chamadas.map((c) => c.rota)).toContain("GET /v1/subscription/8021");
  });

  it("`new` sem pagamento não é cobrança viva: é o link emitido", async () => {
    const { adaptador } = montar({ "GET /v1/subscription/8021": assinaturaLida({ status: "new", history: [{ charge_id: 1, status: "new" }] }) });
    const s = await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    expect(s).toMatchObject({ existe: false, assinaturasVivas: 1, jaPagou: false });
  });

  it("assinatura cancelada é terminal", async () => {
    const { adaptador } = montar({ "GET /v1/subscription/8021": assinaturaLida({ status: "canceled" }) });
    const s = await adaptador.lerSituacao({ clienteRef: REF, assinaturaRef: "8021" });
    expect(s).toMatchObject({ cancelada: true, assinaturasVivas: 0 });
  });

  it("⭐ sem a assinatura, a leitura é a lista de cobranças da empresa (custom_id)", async () => {
    const { adaptador, chamadas } = montar({
      [ROTA_DAS_COBRANCAS]: {
        corpo: {
          code: 200,
          data: [
            {
              id: 1,
              total: 14990,
              status: "paid",
              custom_id: ORG,
              payment: { paid_at: "2026-10-05T12:00:00Z", banking_billet: { link: "https://x/1", expire_at: "2026-10-05" } },
            },
            {
              id: 2,
              total: 14990,
              status: "unpaid",
              custom_id: ORG,
              payment: { banking_billet: { link: "https://x/2", expire_at: "2026-11-05" } },
            },
          ],
        },
      },
    });
    const s = await adaptador.lerSituacao({ clienteRef: REF });
    expect(s).toMatchObject({ assinaturaRef: null, existe: true, emAtraso: true, jaPagou: true, linkDePagamento: "https://x/2", assinaturasVivas: 1 });
    // Só a empresa desta linha é consultada.
    expect(chamadas.find((c) => c.rota === ROTA_DAS_COBRANCAS)?.url.searchParams.get("custom_id")).toBe(ORG);
  });

  it("o cliente do Efi é a nossa empresa: referência de outro formato não existe", async () => {
    const { adaptador } = montar({});
    expect(await adaptador.clienteExiste(REF)).toBe(true);
    expect(await adaptador.clienteExiste(`org:${OUTRA_ORG}`)).toBe(true);
    expect(await adaptador.clienteExiste("cus_123")).toBe(false);
    expect(await adaptador.garantirCliente({ id: ORG, nome: "ACME", email: "d@acme.com", documento: null })).toBe(REF);
  });

  it("⭐ outra empresa não é tocada: a leitura de uma só pergunta pela dela", async () => {
    const { adaptador, chamadas } = montar({ [ROTA_DAS_COBRANCAS]: { corpo: { code: 200, data: [] } } });
    await adaptador.lerSituacao({ clienteRef: `org:${OUTRA_ORG}` });
    const consulta = chamadas.find((c) => c.rota === ROTA_DAS_COBRANCAS)?.url.searchParams.get("custom_id");
    expect(consulta).toBe(OUTRA_ORG);
    expect(consulta).not.toBe(ORG);
  });
});

describe("as ações que o Efi aceita", () => {
  it("expirar a sessão apaga a cobrança; 404 é o efeito desejado", async () => {
    const { adaptador } = montar({ "DELETE /v1/charge/371496106": "sem_corpo", "DELETE /v1/charge/2": { status: 404, corpo: {} } });
    await expect(adaptador.expirarSessao("371496106")).resolves.toBeUndefined();
    await expect(adaptador.expirarSessao("2")).resolves.toBeUndefined();
  });

  it("id de OUTRO provedor na sessão é recusado, não apaga nada", async () => {
    const { adaptador, chamadas } = montar({});
    await expect(adaptador.expirarSessao("cs_test_123")).rejects.toBeInstanceOf(ErroDoProvedor);
    expect(chamadas).toEqual([]);
  });

  it("cancelar encerra a assinatura no Efi", async () => {
    const { adaptador, chamadas } = montar({ "PUT /v1/subscription/8021/cancel": "sem_corpo" });
    await expect(adaptador.cancelarNoFim("8021")).resolves.toBeUndefined();
    expect(chamadas.map((c) => c.rota)).toContain("PUT /v1/subscription/8021/cancel");
  });

  it("⭐ troca de plano é recusada de forma DEFINITIVA (o Efi só edita assinatura de cartão)", async () => {
    const { adaptador, chamadas } = montar({});
    const erro = await adaptador.trocarPlano({ assinaturaRef: "8021", plano: PLANO }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect((erro as ErroDoProvedor).codigo).toBe("troca_de_plano_nao_suportada");
    expect((erro as ErroDoProvedor).transitorio).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("gerenciar é pagar a cobrança aberta; sem ela, null", async () => {
    const { adaptador } = montar({
      [ROTA_DAS_COBRANCAS]: {
        corpo: {
          code: 200,
          data: [{ id: 1, status: "unpaid", custom_id: ORG, payment: { banking_billet: { link: "https://x/1", expire_at: "2026-11-05" } } }],
        },
      },
    });
    expect(await adaptador.urlDeGerenciar({ clienteRef: REF, urlDeVolta: "https://x" })).toBe("https://x/1");
  });
});

describe("o aviso do Efi", () => {
  const URL_DO_AVISO = () => new URL(`https://crm.example.com/api/v1/webhooks/cobranca/efi?org=${encodeURIComponent(REF)}&token=${SEGREDO_DO_AVISO}`);
  const corpo = `notification=09027955-5e06-4ff0-a9c7-46b47b8f1b27`;

  it("⭐ reusar a conexão NÃO troca o token: as faturas já abertas continuam avisando", async () => {
    const { adaptador } = montar({});
    const preparo = await adaptador.prepararWebhook("https://crm.example.com/api/v1/webhooks/cobranca/efi", "dono@example.com");
    expect("manual" in preparo).toBe(true);
    if (!("manual" in preparo)) throw new Error("o Efi não tem cadastro de aviso: é sempre manual");
    expect(preparo.manual.segredo).toBe(SEGREDO_DO_AVISO);
    expect(preparo.manual.url).toBe("https://crm.example.com/api/v1/webhooks/cobranca/efi");
    expect(preparo.manual.eventos).toEqual(["notification"]);
  });

  it("sem token guardado, sorteia um (e não cadastra nada no provedor)", async () => {
    const { adaptador, chamadas } = montar({}, { lerSegredo: async () => null });
    const preparo = await adaptador.prepararWebhook("https://crm.example.com/api/v1/webhooks/cobranca/efi", "dono@example.com");
    if (!("manual" in preparo)) throw new Error("esperava manual");
    expect(preparo.manual.segredo).toHaveLength(43);
    expect(chamadas).toEqual([]);
  });

  it("⭐ form-urlencoded com o token da URL autentica e devolve a empresa", () => {
    const sinal = verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO());
    expect(sinal).toEqual({
      eventoId: `efi:09027955-5e06-4ff0-a9c7-46b47b8f1b27:${Math.floor(AGORA.getTime() / JANELA_DO_AVISO_MS)}`,
      tipo: "notification",
      clienteRef: REF,
    });
  });

  it("⭐ reentrega do MESMO aviso no mesmo minuto cai na mesma linha (idempotência)", () => {
    const primeiro = verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO());
    const reentrega = verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, new Date(AGORA.getTime() + 10_000), URL_DO_AVISO());
    expect(reentrega?.eventoId).toBe(primeiro?.eventoId);
    // O Efi manda o MESMO token para toda mudança de estado: fora da janela, é
    // um aviso NOVO — senão o `paid` seria descartado como duplicado do `new`.
    const depois = verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, new Date(AGORA.getTime() + JANELA_DO_AVISO_MS), URL_DO_AVISO());
    expect(depois?.eventoId).not.toBe(primeiro?.eventoId);
  });

  it("token errado, ausente ou URL ausente são recusados", () => {
    const errada = new URL(`https://crm.example.com/api/v1/webhooks/cobranca/efi?org=${encodeURIComponent(REF)}&token=outro`);
    expect(verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, errada)).toBeNull();
    expect(verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA)).toBeNull();
    expect(verificarWebhookEfi(corpo, new Headers(), "", AGORA, URL_DO_AVISO())).toBeNull();
  });

  it("URL sem empresa, ou corpo sem token de notificação, são recusados", () => {
    const semOrg = new URL(`https://crm.example.com/api/v1/webhooks/cobranca/efi?token=${SEGREDO_DO_AVISO}`);
    expect(verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, semOrg)).toBeNull();
    expect(verificarWebhookEfi("qualquer=coisa", new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO())).toBeNull();
    expect(verificarWebhookEfi("{}", new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO())).toBeNull();
  });

  it("o mesmo aviso em JSON também é aceito (a forma documentada é form, mas o corpo é só um campo)", () => {
    const sinal = verificarWebhookEfi(`{"notification":"09027955-5e06-4ff0-a9c7-46b47b8f1b27"}`, new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO());
    expect(sinal?.clienteRef).toBe(REF);
  });

  it("⭐ o aviso não cria cobrança nem chama o provedor: é ponteiro, e é só da empresa dele", () => {
    const { adaptador, chamadas } = montar({});
    const sinal = adaptador.verificarWebhook(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, URL_DO_AVISO());
    expect(sinal?.clienteRef).toBe(REF);
    expect(chamadas).toEqual([]);
    const outra = new URL(`https://crm.example.com/api/v1/webhooks/cobranca/efi?org=${encodeURIComponent(`org:${OUTRA_ORG}`)}&token=${SEGREDO_DO_AVISO}`);
    expect(verificarWebhookEfi(corpo, new Headers(), SEGREDO_DO_AVISO, AGORA, outra)?.clienteRef).toBe(`org:${OUTRA_ORG}`);
  });
});

describe("a data civil do Efi", () => {
  it("o dia em São Paulo não é o dia em UTC", () => {
    expect(dataCivilEmSaoPaulo(new Date("2026-10-06T02:00:00Z"))).toBe("2026-10-05");
    expect(fimDoDiaEmSaoPaulo("2026-10-05")?.toISOString()).toBe("2026-10-06T02:59:59.000Z");
    expect(fimDoDiaEmSaoPaulo("05/10/2026")).toBeNull();
  });
});

/** Só para ler a URL do metadata sem repetir `new URL` (o campo é uma URL registrada por nós). */
class URLOrNull {
  readonly url: URL | null;
  constructor(valor: string) {
    this.url = URL.canParse(valor) ? new URL(valor) : null;
  }
}
