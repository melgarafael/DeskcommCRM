import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import objetos from "@/tests/fixtures/stripe/objetos.json";

import { ErroDoProvedor } from "./contrato";
import {
  criarAdaptadorStripe,
  emFormulario,
  erroDaStripe,
  marcaDaInstalacao,
  modoDaChaveStripe,
  STRIPE_API_BASE,
  STRIPE_VERSION,
  verificarWebhookStripe,
  type DependenciasDaStripe,
} from "./stripe";

/**
 * O ADAPTADOR DA STRIPE (spec da cobrança do revendedor §6.1), contra uma
 * Stripe de mentira que responde com a forma real da API. Nenhuma chamada
 * real: o teste contra a conta de teste é scripts/smoke-stripe.ts, fora do CI.
 */

// Chaves de mentira no formato real, MONTADAS em tempo de execução: um
// literal `sk_live_…` ou `sk_test_…` no repositório dispara a varredura de
// segredo do GitHub no push (o de teste também: medido em 05/10).
const CHAVE_TESTE = ["sk", "test", "51HfakeKeyForUnitTests00"].join("_");
const CHAVE_REAL = ["sk", "live", "51HfakeKeyForUnitTests00"].join("_");
const RESTRITA_REAL = ["rk", "live", "51HfakeKeyForUnitTests00"].join("_");
/** A marca desta instalação na conta (metadata `cobranca_do_revendedor`). */
const MARCA = "a1b2c3d4e5f60718";

type Resposta = { status?: number; corpo?: unknown; headers?: Record<string, string> } | "rede_caiu";
type Responder = Resposta | Resposta[] | ((url: URL) => Resposta);
type Chamada = { rota: string; url: URL; headers: Headers; corpo: URLSearchParams };

/**
 * Cada rota é "MÉTODO /caminho" (sem `/v1` e sem query). Lista = fila; a última
 * resposta se repete. Rota não declarada → 404 com o nome dela no `code`, para
 * o erro dizer qual chamada o teste não previu.
 */
function stripeFalsa(rotas: Record<string, Responder>) {
  const filas = new Map<string, Responder>(
    Object.entries(rotas).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  );
  const chamadas: Chamada[] = [];
  const fetchFalso: typeof fetch = async (entrada, init) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
    const rota = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/v1/, "")}`;
    chamadas.push({
      rota,
      url,
      headers: new Headers(init?.headers),
      corpo: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    const r = filas.get(rota);
    const resposta = typeof r === "function" ? r(url) : Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r;
    if (resposta === undefined) {
      return Response.json({ error: { code: `rota_nao_declarada:${rota}` } }, { status: 404 });
    }
    if (resposta === "rede_caiu") throw new TypeError("fetch failed");
    return Response.json(resposta.corpo ?? {}, { status: resposta.status ?? 200, headers: resposta.headers });
  };
  return { fetchFalso, chamadas };
}

function montar(rotas: Record<string, Responder>, extra: Partial<DependenciasDaStripe> = {}) {
  const { fetchFalso, chamadas } = stripeFalsa(rotas);
  const esperas: number[] = [];
  const adaptador = criarAdaptadorStripe({
    lerChave: async () => CHAVE_TESTE,
    fetch: fetchFalso,
    esperar: async (ms) => {
      esperas.push(ms);
    },
    agora: () => new Date("2026-10-01T12:00:00Z"),
    novaChaveDeIdempotencia: () => "idem-fixa",
    marca: MARCA,
    ...extra,
  });
  return { adaptador, chamadas, esperas };
}

const LISTA_VAZIA = { corpo: { object: "list", data: [], has_more: false } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("o transporte da Stripe", () => {
  it("⭐ a chave vai só no Authorization, a versão é fixada e a URL não carrega segredo", async () => {
    const { adaptador, chamadas } = montar({ "GET /customers": LISTA_VAZIA });
    await adaptador.testarChave();
    const [c] = chamadas;
    expect(c?.headers.get("authorization")).toBe(`Bearer ${CHAVE_TESTE}`);
    expect(c?.headers.get("stripe-version")).toBe(STRIPE_VERSION);
    expect(`${c?.url.origin}${c?.url.pathname}`).toBe(`${STRIPE_API_BASE}/customers`);
    expect(c?.url.search).not.toMatch(/sk_|rk_/);
  });

  it("emFormulario achata objeto e lista no formato da Stripe e pula nulo", () => {
    const corpo = emFormulario({
      line_items: [{ price_data: { currency: "brl", recurring: { interval: "month" } }, quantity: 1 }],
      enabled_events: ["invoice.paid", "invoice.payment_failed"],
      cancel_at_period_end: true,
      vazio: null,
      ausente: undefined,
    });
    expect([...new URLSearchParams(corpo)]).toEqual([
      ["line_items[0][price_data][currency]", "brl"],
      ["line_items[0][price_data][recurring][interval]", "month"],
      ["line_items[0][quantity]", "1"],
      ["enabled_events[0]", "invoice.paid"],
      ["enabled_events[1]", "invoice.payment_failed"],
      ["cancel_at_period_end", "true"],
    ]);
  });

  it.each([
    [401, { error: { type: "invalid_request_error" } }, { status: 401, codigo: "chave_invalida", transitorio: false, credencialInvalida: true }],
    [403, { error: { type: "invalid_request_error" } }, { status: 403, codigo: "sem_permissao", transitorio: false, credencialInvalida: true }],
    [404, { error: { code: "resource_missing", type: "invalid_request_error" } }, { status: 404, codigo: "resource_missing", transitorio: false, credencialInvalida: false }],
    [400, { error: { type: "idempotency_error" } }, { status: 400, codigo: "idempotency_error", transitorio: false, credencialInvalida: false }],
    [409, { error: { code: "lock_timeout" } }, { status: 409, codigo: "lock_timeout", transitorio: true, credencialInvalida: false }],
    [409, { error: { code: "idempotency_key_in_use" } }, { status: 409, codigo: "idempotency_key_in_use", transitorio: true, credencialInvalida: false }],
    [429, { error: { code: "rate_limit" } }, { status: 429, codigo: "rate_limit", transitorio: true, credencialInvalida: false }],
    [503, null, { status: 503, codigo: "provedor_fora", transitorio: true, credencialInvalida: false }],
  ])("HTTP %i vira o ErroDoProvedor certo", (status, corpo, esperado) => {
    const erro = erroDaStripe(status, corpo);
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect(erro).toMatchObject(esperado);
  });

  it("⭐ o erro nunca carrega o texto da Stripe — ele ecoa pedaço da chave", () => {
    const erro = erroDaStripe(401, {
      error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****abcd" },
    });
    expect(erro.message).toBe("provedor 401 chave_invalida");
    expect(JSON.stringify({ ...erro, m: erro.message })).not.toContain("sk_test");
  });

  it("429, 429, 200: três tentativas, respeitando o Retry-After", async () => {
    const { adaptador, chamadas, esperas } = montar({
      "GET /customers": [
        { status: 429, headers: { "retry-after": "1" }, corpo: { error: { code: "rate_limit" } } },
        { status: 429, corpo: { error: { code: "rate_limit" } } },
        LISTA_VAZIA,
      ],
    });
    expect(await adaptador.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(chamadas).toHaveLength(3);
    expect(esperas).toEqual([1000, 1000]);
  });

  it("5xx persistente: desiste na 3ª (retry LIMITADO) e diz provedor_fora", async () => {
    const { adaptador, chamadas, esperas } = montar({ "GET /customers": { status: 503, corpo: null } });
    expect(await adaptador.testarChave()).toEqual({ ok: false, motivo: "provedor_fora" });
    expect(chamadas).toHaveLength(3);
    expect(esperas).toEqual([500, 1000]);
  });

  it("Stripe-Should-Retry: false manda parar na 1ª, e true manda repetir um 400", async () => {
    const parar = montar({ "GET /customers": { status: 500, headers: { "stripe-should-retry": "false" } } });
    await parar.adaptador.testarChave();
    expect(parar.chamadas).toHaveLength(1);
    const repetir = montar({
      "GET /customers": [{ status: 400, headers: { "stripe-should-retry": "true" }, corpo: { error: { type: "api_error" } } }, LISTA_VAZIA],
    });
    expect(await repetir.adaptador.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(repetir.chamadas).toHaveLength(2);
  });

  it("rede caiu uma vez e voltou: segue; Retry-After enorme é limitado a 5 s", async () => {
    const rede = montar({ "GET /customers": ["rede_caiu", LISTA_VAZIA] });
    expect(await rede.adaptador.testarChave()).toEqual({ ok: true, modo: "teste" });
    const longo = montar({ "GET /customers": [{ status: 429, headers: { "retry-after": "30" } }, LISTA_VAZIA] });
    await longo.adaptador.testarChave();
    expect(longo.esperas).toEqual([5000]);
  });

  it("400 comum não repete", async () => {
    const { adaptador, chamadas } = montar({ "GET /customers": { status: 400, corpo: { error: { code: "parameter_invalid_integer" } } } });
    await adaptador.testarChave();
    expect(chamadas).toHaveLength(1);
  });

  it("o log da nova tentativa não leva a chave", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adaptador } = montar({ "GET /customers": [{ status: 503 }, LISTA_VAZIA] });
    await adaptador.testarChave();
    const escrito = aviso.mock.calls.flat().join(" ");
    expect(escrito).toContain("cobranca.stripe.nova_tentativa");
    expect(escrito).not.toContain(CHAVE_TESTE);
  });

  it("base fora da lista (nem a oficial, nem loopback) lança na construção", () => {
    expect(() =>
      criarAdaptadorStripe({ lerChave: async () => CHAVE_TESTE, baseUrl: "https://coletor.example.com/v1", marca: MARCA }),
    ).toThrow(/recusada/);
  });

  it("⭐ a marca é por instalação: mesma origem, mesma marca; outro domínio, outra marca", () => {
    const producao = marcaDaInstalacao("https://crm.loja.com.br");
    expect(producao).toMatch(/^[0-9a-f]{16}$/);
    expect(marcaDaInstalacao("https://CRM.loja.com.br/")).toBe(producao);
    expect(marcaDaInstalacao("https://homolog.loja.com.br")).not.toBe(producao);
  });
});

describe("testarChave", () => {
  it.each([
    [CHAVE_TESTE, "teste"],
    [["rk", "test", "51HfakeKeyForUnitTests00"].join("_"), "teste"],
    [CHAVE_REAL, "producao"],
    [RESTRITA_REAL, "producao"],
    ["pk_test_51HfakeKeyForUnitTests00", null],
    [["whsec", "51HfakeKeyForUnitTests00"].join("_"), null],
    ["sk_test_curta", null],
    ["", null],
  ])("modoDaChaveStripe(%s) = %s", (chave, modo) => {
    expect(modoDaChaveStripe(chave)).toBe(modo);
  });

  it("chave de teste e restrita de produção: ok com o modo do prefixo", async () => {
    expect(await montar({ "GET /customers": LISTA_VAZIA }).adaptador.testarChave()).toEqual({ ok: true, modo: "teste" });
    const real = montar({ "GET /customers": LISTA_VAZIA }, { lerChave: async () => RESTRITA_REAL });
    expect(await real.adaptador.testarChave()).toEqual({ ok: true, modo: "producao" });
  });

  it("chave publicável ou ausente: chave_invalida SEM chamar a Stripe", async () => {
    const pk = montar({}, { lerChave: async () => "pk_test_51HfakeKeyForUnitTests00" });
    expect(await pk.adaptador.testarChave()).toEqual({ ok: false, motivo: "chave_invalida" });
    const nula = montar({}, { lerChave: async () => null });
    expect(await nula.adaptador.testarChave()).toEqual({ ok: false, motivo: "chave_invalida" });
    expect([...pk.chamadas, ...nula.chamadas]).toHaveLength(0);
  });

  it("401 → chave_invalida; 403 (restrita sem permissão) → sem_permissao", async () => {
    expect(await montar({ "GET /customers": { status: 401 } }).adaptador.testarChave()).toEqual({ ok: false, motivo: "chave_invalida" });
    expect(await montar({ "GET /customers": { status: 403 } }).adaptador.testarChave()).toEqual({ ok: false, motivo: "sem_permissao" });
  });

  it("⭐ instalação em teste recusa chave REAL antes de enviá-la", async () => {
    const { adaptador, chamadas } = montar({ "GET /customers": LISTA_VAZIA }, { lerChave: async () => CHAVE_REAL });
    expect(await adaptador.testarChave({ modoExigido: "teste" })).toEqual({ ok: false, motivo: "modo_divergente", modo: "producao" });
    expect(chamadas).toHaveLength(0);
  });

  it("e o inverso: produção exigida recusa chave de teste", async () => {
    const { adaptador, chamadas } = montar({ "GET /customers": LISTA_VAZIA });
    expect(await adaptador.testarChave({ modoExigido: "producao" })).toEqual({ ok: false, motivo: "modo_divergente", modo: "teste" });
    expect(chamadas).toHaveLength(0);
  });

  it("⭐ com o stub em loopback, chave real nunca sai da máquina", async () => {
    const { adaptador, chamadas } = montar(
      { "GET /customers": LISTA_VAZIA },
      { lerChave: async () => CHAVE_REAL, baseUrl: "http://127.0.0.1:4010/v1" },
    );
    expect(await adaptador.testarChave()).toEqual({ ok: false, motivo: "modo_divergente", modo: "producao" });
    expect(chamadas).toHaveLength(0);
  });
});

describe("verificarWebhook", () => {
  // Montados em tempo de execução: literal whsec_ longo dispara a varredura de segredo no push.
  const SEGREDO = ["whsec", "fixtureSegredoNovo0000000000"].join("_");
  const SEGREDO_VELHO = ["whsec", "fixtureSegredoVelho000000000"].join("_");
  const AGORA = new Date("2026-10-01T12:00:00Z");
  const T = Math.floor(AGORA.getTime() / 1000);
  const CORPO = JSON.stringify(objetos.evento);
  const hmac = (segredo: string, t: number, corpo = CORPO) =>
    createHmac("sha256", segredo).update(`${t}.${corpo}`, "utf8").digest("hex");
  const cab = (valor: string) => new Headers({ "stripe-signature": valor });
  const SINAL = { eventoId: "evt_1QfixtureInvoicePaid", tipo: "invoice.paid", clienteRef: "cus_QfixtureCliente" };

  it("evento assinado vira sinal, só ponteiros, nada do corpo", () => {
    expect(verificarWebhookStripe(CORPO, cab(`t=${T},v1=${hmac(SEGREDO, T)}`), SEGREDO, AGORA)).toEqual(SINAL);
  });

  it("rotação: o segundo v1 é conferido; só o velho não passa com o segredo novo", () => {
    const duplo = `t=${T},v1=${hmac(SEGREDO_VELHO, T)},v1=${hmac(SEGREDO, T)}`;
    expect(verificarWebhookStripe(CORPO, cab(duplo), SEGREDO, AGORA)).toEqual(SINAL);
    expect(verificarWebhookStripe(CORPO, cab(`t=${T},v1=${hmac(SEGREDO_VELHO, T)}`), SEGREDO, AGORA)).toBeNull();
  });

  it("v0 (esquema de teste) é ignorado, mesmo com HMAC certo", () => {
    expect(verificarWebhookStripe(CORPO, cab(`t=${T},v0=${hmac(SEGREDO, T)}`), SEGREDO, AGORA)).toBeNull();
  });

  it("relógio: 301 s no passado ou no futuro recusa; 299 s no futuro (nosso relógio atrasado) passa", () => {
    expect(verificarWebhookStripe(CORPO, cab(`t=${T - 301},v1=${hmac(SEGREDO, T - 301)}`), SEGREDO, AGORA)).toBeNull();
    expect(verificarWebhookStripe(CORPO, cab(`t=${T + 301},v1=${hmac(SEGREDO, T + 301)}`), SEGREDO, AGORA)).toBeNull();
    expect(verificarWebhookStripe(CORPO, cab(`t=${T + 299},v1=${hmac(SEGREDO, T + 299)}`), SEGREDO, AGORA)).toEqual(SINAL);
  });

  it("corpo alterado em um byte recusa", () => {
    expect(verificarWebhookStripe(`${CORPO} `, cab(`t=${T},v1=${hmac(SEGREDO, T)}`), SEGREDO, AGORA)).toBeNull();
  });

  it.each([
    ["sem header", new Headers()],
    ["header lixo", cab("lixo")],
    ["v1 curto", cab(`t=${T},v1=abc`)],
    ["t não numérico", cab(`t=ontem,v1=${hmac(SEGREDO, T)}`)],
  ])("%s → null, sem lançar", (_nome, headers) => {
    expect(verificarWebhookStripe(CORPO, headers, SEGREDO, AGORA)).toBeNull();
  });

  it("relógio inválido (NaN) recusa em vez de pular a janela", () => {
    expect(verificarWebhookStripe(CORPO, cab(`t=${T},v1=${hmac(SEGREDO, T)}`), SEGREDO, new Date(Number.NaN))).toBeNull();
  });

  it("segredo vazio nunca valida", () => {
    expect(verificarWebhookStripe(CORPO, cab(`t=${T},v1=${hmac("", T)}`), "", AGORA)).toBeNull();
  });

  it("evento repetido devolve o MESMO eventoId — quem deduplica é o (provider, external_id) da rota", () => {
    const h = cab(`t=${T},v1=${hmac(SEGREDO, T)}`);
    expect(verificarWebhookStripe(CORPO, h, SEGREDO, AGORA)?.eventoId).toBe(verificarWebhookStripe(CORPO, h, SEGREDO, AGORA)?.eventoId);
  });

  it("assinado mas não é evento (sem evt_) → null", () => {
    const corpo = JSON.stringify({ id: "in_1", type: "invoice.paid", data: { object: {} } });
    expect(verificarWebhookStripe(corpo, cab(`t=${T},v1=${hmac(SEGREDO, T, corpo)}`), SEGREDO, AGORA)).toBeNull();
  });

  it("customer expandido dá o id; customer nulo dá clienteRef null", () => {
    const expandido = JSON.stringify({ ...objetos.evento, data: { object: { customer: { id: "cus_X" } } } });
    const nulo = JSON.stringify({ ...objetos.evento, data: { object: { customer: null } } });
    expect(verificarWebhookStripe(expandido, cab(`t=${T},v1=${hmac(SEGREDO, T, expandido)}`), SEGREDO, AGORA)?.clienteRef).toBe("cus_X");
    expect(verificarWebhookStripe(nulo, cab(`t=${T},v1=${hmac(SEGREDO, T, nulo)}`), SEGREDO, AGORA)?.clienteRef).toBeNull();
  });

  it("a comparação é em tempo constante (timingSafeEqual), nunca === entre strings", () => {
    const fonte = readFileSync(join(__dirname, "stripe.ts"), "utf8");
    expect(fonte).toContain("timingSafeEqual(");
    expect(fonte).not.toMatch(/===\s*esperada|esperada\s*===/);
  });

  it("o adaptador expõe a mesma função", () => {
    const { adaptador } = montar({});
    expect(adaptador.verificarWebhook(CORPO, cab(`t=${T},v1=${hmac(SEGREDO, T)}`), SEGREDO, AGORA)).toEqual(SINAL);
  });
});

describe("garantirCliente e iniciarAssinatura", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const PLANO = { id: "22222222-2222-4222-8222-222222222222", nome: "Pro", precoCents: 4990, intervalo: "mes" as const };
  const PRODUTO = `dc_plano_${PLANO.id}`;
  const SESSAO = { corpo: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: 1790086400 } };
  const base = {
    clienteRef: "cus_QfixtureCliente",
    orgId: ORG,
    plano: PLANO,
    trialAte: null,
    urlDeVolta: "https://crm.example.com/app/settings/billing",
    chaveIdempotencia: "3f1c2d4e-0000-4000-8000-000000000001",
  };

  it("reusa o cliente que a busca por organization_id acha, sem criar outro", async () => {
    const { adaptador, chamadas } = montar({
      "GET /customers/search": { corpo: { object: "search_result", data: [{ id: "cus_existente" }] } },
    });
    expect(await adaptador.garantirCliente({ id: ORG, nome: "Loja", email: "a@example.com", documento: null })).toBe("cus_existente");
    expect(chamadas.map((c) => c.rota)).toEqual(["GET /customers/search"]);
    expect(chamadas[0]?.url.searchParams.get("query")).toBe(`metadata['organization_id']:'${ORG}'`);
  });

  it("⭐ sem cliente: cria com e-mail, nome e organization_id, com Idempotency-Key DA ORG (a busca demora ~1 min a enxergar o novo)", async () => {
    const criar = () =>
      montar({
        "GET /customers/search": { corpo: { object: "search_result", data: [] } },
        "POST /customers": { corpo: { id: "cus_novo" } },
      });
    const primeiro = criar();
    expect(await primeiro.adaptador.garantirCliente({ id: ORG, nome: "Loja", email: "a@example.com", documento: "12345678909" })).toBe("cus_novo");
    const post = primeiro.chamadas[1];
    expect(Object.fromEntries(post?.corpo ?? [])).toEqual({ email: "a@example.com", name: "Loja", "metadata[organization_id]": ORG });
    // Segundo clique dentro do atraso do índice de busca: a MESMA chave faz a Stripe devolver o mesmo cliente (24 h).
    const segundo = criar();
    await segundo.adaptador.garantirCliente({ id: ORG, nome: "Loja", email: "a@example.com", documento: null });
    expect(post?.headers.get("idempotency-key")).toBe(`cliente:${ORG}`);
    expect(segundo.chamadas[1]?.headers.get("idempotency-key")).toBe(`cliente:${ORG}`);
  });

  it("URL do Checkout que não é https → resposta_invalida (nunca vira redirect)", async () => {
    const { adaptador } = montar({
      "POST /products": { corpo: { id: PRODUTO } },
      "POST /checkout/sessions": { corpo: { id: "cs_x", url: "javascript:alert(1)", expires_at: 1790086400 } },
    });
    expect(await adaptador.iniciarAssinatura(base).catch((e: unknown) => e)).toMatchObject({ codigo: "resposta_invalida" });
  });

  it("id de org que não é uuid nunca entra na consulta", async () => {
    const { adaptador, chamadas } = montar({});
    await expect(adaptador.garantirCliente({ id: "x' OR '1", nome: "L", email: "a@example.com", documento: null })).rejects.toThrow();
    expect(chamadas).toHaveLength(0);
  });

  it("⭐ o Checkout: assinatura, cliente reutilizado, metadados da org e do plano, formas de pagamento da conta", async () => {
    const { adaptador, chamadas } = montar({ "POST /products": { corpo: { id: PRODUTO } }, "POST /checkout/sessions": SESSAO });
    expect(await adaptador.iniciarAssinatura(base)).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
      expiraEm: new Date(1790086400 * 1000),
      assinaturaRef: null,
    });
    const checkout = chamadas.find((c) => c.rota === "POST /checkout/sessions");
    expect(Object.fromEntries(checkout?.corpo ?? [])).toEqual({
      mode: "subscription",
      customer: "cus_QfixtureCliente",
      client_reference_id: ORG,
      "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][unit_amount]": "4990",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product]": PRODUTO,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][organization_id]": ORG,
      "subscription_data[metadata][plano_id]": PLANO.id,
      "metadata[organization_id]": ORG,
      "metadata[plano_id]": PLANO.id,
      success_url: "https://crm.example.com/app/settings/billing?voltou=1",
      cancel_url: "https://crm.example.com/app/settings/billing",
      locale: "pt-BR",
    });
    // Sem payment_method_types: cartão e boleto aparecem conforme o painel da conta.
    expect(checkout?.headers.get("idempotency-key")).toBe(`${base.chaveIdempotencia}:checkout`);
  });

  it("teste grátis ≥ 48 h + 10 min vai como trial_end; 48 h cravadas não vão (relógio e novas tentativas comem a margem)", async () => {
    const agora = new Date("2026-10-01T12:00:00Z").getTime();
    const LIMITE_S = 48 * 3600 + 10 * 60;
    const com = montar({ "POST /products": { corpo: { id: PRODUTO } }, "POST /checkout/sessions": SESSAO });
    await com.adaptador.iniciarAssinatura({ ...base, trialAte: new Date(agora + LIMITE_S * 1000) });
    expect(com.chamadas[1]?.corpo.get("subscription_data[trial_end]")).toBe(String(Math.floor(agora / 1000) + LIMITE_S));
    const sem = montar({ "POST /products": { corpo: { id: PRODUTO } }, "POST /checkout/sessions": SESSAO });
    await sem.adaptador.iniciarAssinatura({ ...base, trialAte: new Date(agora + 48 * 3600_000) });
    expect(sem.chamadas[1]?.corpo.has("subscription_data[trial_end]")).toBe(false);
  });

  it("plano anual vira interval=year", async () => {
    const { adaptador, chamadas } = montar({ "POST /products": { corpo: { id: PRODUTO } }, "POST /checkout/sessions": SESSAO });
    await adaptador.iniciarAssinatura({ ...base, plano: { ...PLANO, intervalo: "ano" } });
    expect(chamadas[1]?.corpo.get("line_items[0][price_data][recurring][interval]")).toBe("year");
  });

  it("produto que já existe (resource_already_exists) é atualizado com o nome e o fluxo segue", async () => {
    const { adaptador, chamadas } = montar({
      "POST /products": { status: 400, corpo: { error: { code: "resource_already_exists" } } },
      [`POST /products/${PRODUTO}`]: { corpo: { id: PRODUTO } },
      "POST /checkout/sessions": SESSAO,
    });
    await adaptador.iniciarAssinatura(base);
    expect(chamadas.map((c) => c.rota)).toEqual(["POST /products", `POST /products/${PRODUTO}`, "POST /checkout/sessions"]);
    expect(chamadas[1]?.corpo.get("name")).toBe("Pro");
  });

  it("⭐ Checkout fora do ar: 3 tentativas com a MESMA Idempotency-Key, e lança transitório", async () => {
    const { adaptador, chamadas } = montar({ "POST /products": { corpo: { id: PRODUTO } }, "POST /checkout/sessions": { status: 502 } });
    const erro = await adaptador.iniciarAssinatura(base).catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 502, transitorio: true });
    const chaves = chamadas.filter((c) => c.rota === "POST /checkout/sessions").map((c) => c.headers.get("idempotency-key"));
    expect(chaves).toEqual(Array(3).fill(`${base.chaveIdempotencia}:checkout`));
  });
});

describe("lerSituacao", () => {
  // O JSON tem estes três como `null`, e o tipo inferido fica `null`; na Stripe são `number | null`.
  type Assinatura = Omit<typeof objetos.assinatura, "trial_end" | "ended_at" | "cancel_at"> & {
    trial_end: number | null;
    ended_at: number | null;
    cancel_at: number | null;
  };
  type Fatura = typeof objetos.fatura;
  const sub = (o: Partial<Assinatura> & { id?: string }): Assinatura => ({ ...objetos.assinatura, ...o });
  const fatura = (o: Partial<Fatura>): Fatura => ({ ...objetos.fatura, ...o });
  const lista = (...data: unknown[]) => ({ corpo: { object: "list", data, has_more: false } });
  const FIM_DO_ITEM = new Date(1792592000 * 1000);

  function ler(assinaturas: Assinatura[], pagas: Fatura[], abertas: Fatura[] = [], incobraveis: Fatura[] = []) {
    return montar({
      "GET /subscriptions": lista(...assinaturas),
      "GET /invoices": (url) => {
        const status = url.searchParams.get("status");
        return status === "paid" ? lista(...pagas) : status === "uncollectible" ? lista(...incobraveis) : lista(...abertas);
      },
    });
  }

  it("⭐ active pago: existe, em dia, fim do período = current_period_end do ITEM", async () => {
    const { adaptador, chamadas } = ler([sub({})], [fatura({})]);
    expect(await adaptador.lerSituacao({ clienteRef: "cus_QfixtureCliente" })).toEqual({
      assinaturaRef: "sub_1QfixtureAtiva",
      existe: true,
      assinaturasVivas: 1,
      cancelada: false,
      cancelaNoFim: false,
      emAtraso: false,
      vencidaDesde: null,
      proximoVencimento: FIM_DO_ITEM,
      jaPagou: true,
      emTesteNoProvedorAte: null,
      pagamentoSemAssinaturaViva: false,
      linkDePagamento: null,
      statusBruto: "active",
    });
    const subs = chamadas.find((c) => c.rota === "GET /subscriptions");
    expect(Object.fromEntries(subs?.url.searchParams ?? [])).toEqual({ customer: "cus_QfixtureCliente", status: "all", limit: "10" });
  });

  it.each(["past_due", "unpaid", "paused"])("%s: existe e está em atraso", async (status) => {
    const s = await ler([sub({ status })], [fatura({})]).adaptador.lerSituacao({ clienteRef: "cus_QfixtureCliente" });
    expect(s).toMatchObject({ existe: true, emAtraso: true, vencidaDesde: null });
  });

  it("⭐ unpaid sem fatura aberta, com fatura INCOBRÁVEL: o link é o dela (ainda se paga pela página)", async () => {
    const incobravel = fatura({ id: "in_incobravel", amount_paid: 0, hosted_invoice_url: "https://invoice.stripe.com/i/incobravel" });
    const s = await ler([sub({ status: "unpaid" })], [fatura({})], [], [incobravel]).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ emAtraso: true, linkDePagamento: "https://invoice.stripe.com/i/incobravel" });
  });

  it("paused sem fatura nenhuma: em atraso e sem link (o caminho é o portal)", async () => {
    const s = await ler([sub({ status: "paused" })], [fatura({})], [], []).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ emAtraso: true, linkDePagamento: null });
  });

  it("em dia não pergunta pelas incobráveis", async () => {
    const { adaptador, chamadas } = ler([sub({})], [fatura({})]);
    await adaptador.lerSituacao({ clienteRef: "c" });
    expect(chamadas.some((c) => c.url.searchParams.get("status") === "uncollectible")).toBe(false);
  });

  it("⭐ hosted_invoice_url que não é https → linkDePagamento null (nunca vira href nem botão de e-mail)", async () => {
    const adulterada = fatura({ id: "in_x", amount_paid: 0, hosted_invoice_url: "javascript:alert(1)" });
    const s = await ler([sub({ status: "past_due" })], [fatura({})], [adulterada]).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s.linkDePagamento).toBeNull();
  });

  it("⭐ active com boleto aberto dentro da validade: EM DIA, com o link da fatura mais antiga", async () => {
    const nova = fatura({ id: "in_nova", created: 1790000900, amount_paid: 0, hosted_invoice_url: "https://invoice.stripe.com/i/nova" });
    const velha = fatura({ id: "in_velha", created: 1790000500, amount_paid: 0, hosted_invoice_url: "https://invoice.stripe.com/i/velha" });
    const s = await ler([sub({})], [fatura({})], [nova, velha]).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ emAtraso: false, existe: true, linkDePagamento: "https://invoice.stripe.com/i/velha" });
  });

  it("incomplete (1º pagamento pendente): não existe, mas conta como viva", async () => {
    const s = await ler([sub({ status: "incomplete" })], []).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ existe: false, assinaturasVivas: 1, emAtraso: false, cancelada: false, proximoVencimento: null, jaPagou: false });
  });

  it("trialing: não existe; o fim do teste lá vira emTesteNoProvedorAte", async () => {
    const s = await ler([sub({ status: "trialing", trial_end: 1791000000 })], []).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ existe: false, assinaturasVivas: 1, emTesteNoProvedorAte: new Date(1791000000 * 1000), proximoVencimento: new Date(1791000000 * 1000) });
  });

  it("fatura de teste de R$ 0 não conta em jaPagou", async () => {
    const s = await ler([sub({ status: "trialing", trial_end: 1791000000 })], [fatura({ amount_paid: 0 })]).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s.jaPagou).toBe(false);
  });

  it("⭐ auto-cancelada + reassinatura paga + fatura antiga aberta → ativa, e as faturas abertas são da NOVA", async () => {
    const velha = sub({ id: "sub_velha", status: "canceled", created: 1780000000, ended_at: 1785000000 });
    const nova = sub({ id: "sub_nova", created: 1790000000 });
    const { adaptador, chamadas } = ler([velha, nova], [fatura({ parent: { type: "subscription_details", subscription_details: { subscription: "sub_nova", metadata: {} } } })]);
    const s = await adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ assinaturaRef: "sub_nova", existe: true, emAtraso: false, cancelada: false, assinaturasVivas: 1, linkDePagamento: null });
    const abertas = chamadas.find((c) => c.rota === "GET /invoices" && c.url.searchParams.get("status") === "open");
    expect(abertas?.url.searchParams.get("subscription")).toBe("sub_nova");
  });

  it("só canceladas: cancelada, sem link, sem pedir faturas abertas", async () => {
    const { adaptador, chamadas } = ler([sub({ status: "canceled", ended_at: 1795000000 })], [fatura({})]);
    const s = await adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ cancelada: true, existe: false, assinaturaRef: "sub_1QfixtureAtiva", linkDePagamento: null, proximoVencimento: null, statusBruto: "canceled:encerrada" });
    expect(chamadas.some((c) => c.url.searchParams.get("status") === "open")).toBe(false);
  });

  it("cancel_at_period_end ou cancel_at marcam cancelaNoFim, e ela segue existindo", async () => {
    expect(await ler([sub({ cancel_at_period_end: true })], [fatura({})]).adaptador.lerSituacao({ clienteRef: "c" })).toMatchObject({ cancelaNoFim: true, existe: true, statusBruto: "active:cancela_no_fim" });
    expect(await ler([sub({ cancel_at: 1792592000 })], [fatura({})]).adaptador.lerSituacao({ clienteRef: "c" })).toMatchObject({ cancelaNoFim: true });
  });

  it("cliente sem assinatura nenhuma", async () => {
    expect(await ler([], []).adaptador.lerSituacao({ clienteRef: "c" })).toMatchObject({ assinaturaRef: null, existe: false, cancelada: false, assinaturasVivas: 0, statusBruto: "sem_assinatura" });
  });

  it("pagou fatura de assinatura DEPOIS de ela terminar → pagamentoSemAssinaturaViva; antes, não", async () => {
    const encerrada = sub({ id: "sub_fim", status: "canceled", ended_at: 1790000000 });
    const paga = (pagaEm: number) => fatura({ status_transitions: { paid_at: pagaEm }, parent: { type: "subscription_details", subscription_details: { subscription: "sub_fim", metadata: {} } } });
    expect((await ler([encerrada], [paga(1790000500)]).adaptador.lerSituacao({ clienteRef: "c" })).pagamentoSemAssinaturaViva).toBe(true);
    expect((await ler([encerrada], [paga(1789999000)]).adaptador.lerSituacao({ clienteRef: "c" })).pagamentoSemAssinaturaViva).toBe(false);
  });

  it("duas vivas: conta 2 e a principal é a mais recente", async () => {
    const s = await ler([sub({ id: "sub_a", created: 1780000000 }), sub({ id: "sub_b", created: 1790000000 })], [fatura({})]).adaptador.lerSituacao({ clienteRef: "c" });
    expect(s).toMatchObject({ assinaturasVivas: 2, assinaturaRef: "sub_b" });
  });

  it("forma inesperada (sem items) → resposta_invalida, não transitória", async () => {
    const { items: _semItens, ...quebrada } = objetos.assinatura;
    const erro = await montar({ "GET /subscriptions": lista(quebrada), "GET /invoices": lista() }).adaptador.lerSituacao({ clienteRef: "c" }).catch((e: unknown) => e);
    expect(erro).toMatchObject({ codigo: "resposta_invalida", transitorio: false });
  });

  it("sem chave → credencialInvalida (sincronizar grava credencial_invalida), sem chamar", async () => {
    const { adaptador, chamadas } = montar({}, { lerChave: async () => null });
    expect(await adaptador.lerSituacao({ clienteRef: "c" }).catch((e: unknown) => e)).toMatchObject({ codigo: "sem_chave", credencialInvalida: true });
    expect(chamadas).toHaveLength(0);
  });

  it("503 persistente → ErroDoProvedor transitório (estado intacto, retry do drain)", async () => {
    const erro = await montar({ "GET /subscriptions": { status: 503 }, "GET /invoices": { status: 503 } }).adaptador.lerSituacao({ clienteRef: "c" }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect(erro).toMatchObject({ transitorio: true });
  });
});

describe("trocarPlano, cancelarNoFim, prepararWebhook e portal", () => {
  const NOVO = { id: "33333333-3333-4333-8333-333333333333", nome: "Max", precoCents: 9990, intervalo: "mes" as const };
  const PRODUTO_NOVO = `dc_plano_${NOVO.id}`;
  const URL_DO_WEBHOOK = "https://crm.example.com/api/v1/webhooks/cobranca/stripe";

  it("⭐ trocarPlano: preço novo no MESMO item, sem proração — vale na próxima fatura (D-3)", async () => {
    const { adaptador, chamadas } = montar({
      "GET /subscriptions/sub_1QfixtureAtiva": { corpo: objetos.assinatura },
      "POST /products": { corpo: { id: PRODUTO_NOVO } },
      "POST /subscriptions/sub_1QfixtureAtiva": { corpo: objetos.assinatura },
    });
    await adaptador.trocarPlano({ assinaturaRef: "sub_1QfixtureAtiva", plano: NOVO });
    const post = chamadas.find((c) => c.rota === "POST /subscriptions/sub_1QfixtureAtiva");
    expect(Object.fromEntries(post?.corpo ?? [])).toEqual({
      "items[0][id]": "si_QfixtureItem",
      "items[0][price_data][currency]": "brl",
      "items[0][price_data][unit_amount]": "9990",
      "items[0][price_data][recurring][interval]": "month",
      "items[0][price_data][product]": PRODUTO_NOVO,
      proration_behavior: "none",
      "metadata[plano_id]": NOVO.id,
    });
  });

  it("trocarPlano em assinatura encerrada: a recusa da Stripe sobe não transitória", async () => {
    const erro = await montar({
      "GET /subscriptions/sub_x": { corpo: { ...objetos.assinatura, id: "sub_x", status: "canceled" } },
      "POST /products": { corpo: { id: PRODUTO_NOVO } },
      "POST /subscriptions/sub_x": { status: 400, corpo: { error: { type: "invalid_request_error" } } },
    }).adaptador.trocarPlano({ assinaturaRef: "sub_x", plano: NOVO }).catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 400, transitorio: false });
  });

  it("assinatura sem item → assinatura_sem_item, sem mexer em nada", async () => {
    const { adaptador, chamadas } = montar({ "GET /subscriptions/sub_x": { corpo: { ...objetos.assinatura, items: { data: [] } } } });
    expect(await adaptador.trocarPlano({ assinaturaRef: "sub_x", plano: NOVO }).catch((e: unknown) => e)).toMatchObject({ codigo: "assinatura_sem_item" });
    expect(chamadas.filter((c) => c.rota.startsWith("POST"))).toHaveLength(0);
  });

  it("cancelarNoFim marca cancel_at_period_end (acesso até o fim do pago, D-14)", async () => {
    const { adaptador, chamadas } = montar({ "POST /subscriptions/sub_x": { corpo: objetos.assinatura } });
    await adaptador.cancelarNoFim("sub_x");
    expect(Object.fromEntries(chamadas[0]?.corpo ?? [])).toEqual({ cancel_at_period_end: "true" });
    expect(chamadas[0]?.headers.get("idempotency-key")).toBe("idem-fixa");
  });

  /** Uma conta com estado: endpoints e configurações de portal vivem entre as chamadas. */
  function contaComEstado(inicial: Array<{ id: string; url: string; metadata: Record<string, string> }>) {
    const endpoints = [...inicial];
    const portais: Array<{ id: string; metadata: Record<string, string> }> = [];
    let seq = 0;
    const fetchComEstado: typeof fetch = async (entrada, init) => {
      const url = new URL(String(entrada));
      const caminho = url.pathname.replace(/^\/v1/, "");
      const metodo = init?.method ?? "GET";
      const corpo = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (metodo === "GET" && caminho === "/webhook_endpoints") return Response.json({ object: "list", data: endpoints });
      if (metodo === "POST" && caminho === "/webhook_endpoints") {
        seq += 1;
        const e = { id: `we_${seq}`, url: corpo.get("url") ?? "", metadata: { cobranca_do_revendedor: corpo.get("metadata[cobranca_do_revendedor]") ?? "" } };
        endpoints.push(e);
        return Response.json({ ...e, secret: `whsec_novo${seq}` });
      }
      if (metodo === "DELETE" && caminho.startsWith("/webhook_endpoints/")) {
        const id = caminho.split("/")[2];
        const i = endpoints.findIndex((e) => e.id === id);
        // Como a Stripe: apagar o que não existe é 404 (splice(-1) apagaria o último).
        if (i < 0) return Response.json({ error: { code: "resource_missing", type: "invalid_request_error" } }, { status: 404 });
        endpoints.splice(i, 1);
        return Response.json({ id, deleted: true });
      }
      if (metodo === "GET" && caminho === "/billing_portal/configurations") return Response.json({ object: "list", data: portais });
      if (metodo === "POST" && caminho === "/billing_portal/configurations") {
        const p = { id: `bpc_${portais.length + 1}`, metadata: { cobranca_do_revendedor: corpo.get("metadata[cobranca_do_revendedor]") ?? "" } };
        portais.push(p);
        return Response.json(p);
      }
      if (metodo === "POST" && caminho.startsWith("/billing_portal/configurations/")) return Response.json({ id: caminho.split("/")[3] });
      if (metodo === "POST" && caminho === "/billing_portal/sessions") {
        return Response.json({ url: `https://billing.stripe.com/p/session/${corpo.get("configuration")}` });
      }
      return Response.json({ error: { code: `rota_nao_declarada:${metodo} ${caminho}` } }, { status: 404 });
    };
    const adaptador = criarAdaptadorStripe({ lerChave: async () => CHAVE_TESTE, fetch: fetchComEstado, esperar: async () => undefined, marca: MARCA });
    return { adaptador, endpoints, portais };
  }

  /** `prepararWebhook` do adaptador Stripe nunca devolve o ramo `manual` (é do Asaas). */
  async function preparar(a: ReturnType<typeof criarAdaptadorStripe>, url = URL_DO_WEBHOOK) {
    const r = await a.prepararWebhook(url, "dono@example.com");
    if ("manual" in r) throw new Error("stripe não devolve manual");
    return r;
  }

  it("⭐ prepararWebhook + confirmar é idempotente: termina com UM endpoint nosso; o alheio e o de OUTRA instalação ficam", async () => {
    const alheio = { id: "we_alheio", url: "https://outro.example.com/hook", metadata: {} };
    const daHomologacao = {
      id: "we_homolog",
      url: "https://homolog.example.com/api/v1/webhooks/cobranca/stripe",
      metadata: { cobranca_do_revendedor: "f0f0f0f0f0f0f0f0" },
    };
    const nossoDeAntes = { id: "we_nosso_antes", url: "https://crm.example.com/api/v1/webhooks/cobranca/stripe", metadata: { cobranca_do_revendedor: MARCA } };
    const conta = contaComEstado([alheio, daHomologacao, nossoDeAntes]);
    const primeira = await preparar(conta.adaptador);
    expect(primeira.segredo).toBe("whsec_novo1");
    await primeira.confirmar();
    const segunda = await preparar(conta.adaptador);
    expect(segunda.segredo).toBe("whsec_novo2");
    await segunda.confirmar();
    expect(conta.endpoints.map((e) => e.id)).toEqual(["we_alheio", "we_homolog", "we_2"]);
    expect(conta.portais).toHaveLength(1);
  });

  it("⭐ sem confirmar, o antigo segue valendo; desfazer apaga só o NOVO", async () => {
    const nossoDeAntes = { id: "we_nosso_antes", url: URL_DO_WEBHOOK, metadata: { cobranca_do_revendedor: MARCA } };
    const conta = contaComEstado([nossoDeAntes]);
    const preparado = await preparar(conta.adaptador);
    expect(conta.endpoints.map((e) => e.id)).toEqual(["we_nosso_antes", "we_1"]);
    await preparado.desfazer();
    expect(conta.endpoints.map((e) => e.id)).toEqual(["we_nosso_antes"]);
    // Segunda tentativa (ou alguém apagou no painel): 404 da Stripe não é falha.
    await expect(preparado.desfazer()).resolves.toBeUndefined();
    expect(conta.endpoints.map((e) => e.id)).toEqual(["we_nosso_antes"]);
  });

  it("removerWebhooks apaga os desta instalação e devolve quantos (a publicação limpa o do modo de teste)", async () => {
    const alheio = { id: "we_alheio", url: "https://outro.example.com/hook", metadata: {} };
    const conta = contaComEstado([alheio, { id: "we_nosso", url: URL_DO_WEBHOOK, metadata: { cobranca_do_revendedor: MARCA } }]);
    expect(await conta.adaptador.removerWebhooks(URL_DO_WEBHOOK)).toBe(1);
    expect(conta.endpoints.map((e) => e.id)).toEqual(["we_alheio"]);
  });

  it("⭐ clienteExiste: 200 → true; 404 resource_missing (chave de OUTRA conta) → false; 503 sobe", async () => {
    expect(await montar({ "GET /customers/cus_1": { corpo: { id: "cus_1", object: "customer" } } }).adaptador.clienteExiste("cus_1")).toBe(true);
    expect(
      await montar({ "GET /customers/cus_1": { status: 404, corpo: { error: { code: "resource_missing" } } } }).adaptador.clienteExiste("cus_1"),
    ).toBe(false);
    const erro = await montar({ "GET /customers/cus_1": { status: 503 } }).adaptador.clienteExiste("cus_1").catch((e: unknown) => e);
    expect(erro).toMatchObject({ transitorio: true });
  });

  it("⭐ falha do portal NÃO deixa endpoint órfão: nada é criado na conta", async () => {
    const { adaptador, chamadas } = montar({
      "GET /billing_portal/configurations": { corpo: { object: "list", data: [] } },
      "POST /billing_portal/configurations": { status: 403, corpo: { error: { code: "permission_error" } } },
      "POST /webhook_endpoints": { corpo: { id: "we_new", secret: "whsec_x" } },
    });
    await expect(adaptador.prepararWebhook(URL_DO_WEBHOOK, "dono@example.com")).rejects.toBeDefined();
    expect(chamadas.some((c) => c.rota === "POST /webhook_endpoints")).toBe(false);
  });

  it("⭐ cria ANTES de apagar, com os eventos certos, a versão fixada e nunca invoice.created", async () => {
    const { adaptador, chamadas } = montar({
      "GET /webhook_endpoints": { corpo: { object: "list", data: [{ id: "we_old", url: URL_DO_WEBHOOK, metadata: {} }] } },
      "POST /webhook_endpoints": { corpo: { id: "we_new", secret: "whsec_x" } },
      "DELETE /webhook_endpoints/we_old": { corpo: { id: "we_old", deleted: true } },
      "GET /billing_portal/configurations": { corpo: { object: "list", data: [] } },
      "POST /billing_portal/configurations": { corpo: { id: "bpc_1" } },
    });
    await (await preparar(adaptador)).confirmar();
    const rotas = chamadas.map((c) => c.rota);
    expect(rotas.indexOf("POST /webhook_endpoints")).toBeLessThan(rotas.indexOf("DELETE /webhook_endpoints/we_old"));
    const criar = chamadas.find((c) => c.rota === "POST /webhook_endpoints");
    expect(criar?.corpo.getAll("enabled_events[0]")).toEqual(["checkout.session.completed"]);
    expect([...(criar?.corpo ?? [])].filter(([k]) => k.startsWith("enabled_events")).map(([, v]) => v)).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "invoice.paid",
      "invoice.payment_failed",
    ]);
    expect(criar?.corpo.get("api_version")).toBe(STRIPE_VERSION);
    expect(criar?.corpo.get("url")).toBe(URL_DO_WEBHOOK);
    const portal = chamadas.find((c) => c.rota === "POST /billing_portal/configurations");
    expect(Object.fromEntries(portal?.corpo ?? [])).toMatchObject({
      "features[payment_method_update][enabled]": "true",
      "features[invoice_history][enabled]": "true",
      "features[subscription_cancel][enabled]": "true",
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_update][enabled]": "false",
      "metadata[cobranca_do_revendedor]": MARCA,
    });
  });

  it("criação sem segredo whsec_ na resposta → resposta_invalida, e nada é apagado", async () => {
    const { adaptador, chamadas } = montar({
      "GET /webhook_endpoints": { corpo: { object: "list", data: [{ id: "we_old", url: URL_DO_WEBHOOK, metadata: {} }] } },
      "POST /webhook_endpoints": { corpo: { id: "we_new" } },
      "GET /billing_portal/configurations": { corpo: { object: "list", data: [] } },
      "POST /billing_portal/configurations": { corpo: { id: "bpc_1" } },
    });
    expect(await preparar(adaptador).catch((e: unknown) => e)).toMatchObject({ codigo: "resposta_invalida" });
    expect(chamadas.some((c) => c.rota.startsWith("DELETE"))).toBe(false);
  });

  it("portal: usa a configuração NOSSA (sem troca de plano); sem ela, cria antes da sessão", async () => {
    const conta = contaComEstado([]);
    const url = await conta.adaptador.urlDeGerenciar({ clienteRef: "cus_1", urlDeVolta: "https://crm.example.com/app/settings/billing" });
    expect(url).toBe("https://billing.stripe.com/p/session/bpc_1");
    expect(await conta.adaptador.urlDeGerenciar({ clienteRef: "cus_1", urlDeVolta: "https://crm.example.com/x" })).toBe(url);
    expect(conta.portais).toHaveLength(1);
  });
});
