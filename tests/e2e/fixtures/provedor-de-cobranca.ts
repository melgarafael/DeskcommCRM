/**
 * Dublê do provedor de cobrança para o e2e. Fala o subconjunto da API da
 * Stripe que `lib/cobranca/provedores/stripe.ts` usa (spec da cobrança §6.1).
 * ASSINA os avisos de verdade (Stripe-Signature, HMAC-SHA256 com o whsec que ele
 * mesmo entregou no POST /v1/webhook_endpoints) e os manda à rota real do app.
 *
 * Formas: as da API 2025-03-31.basil em diante. A fatura aponta a assinatura em
 * `parent.subscription_details.subscription`, e o fim do período mora no ITEM
 * da assinatura. Requisição com Stripe-Version anterior é recusada: um verde
 * contra formas de outra versão provaria o dublê, não o adaptador. O dublê é
 * MAIS estrito que a Stripe onde a spec é: POST sem Idempotency-Key,
 * `invoice.created`, portal com troca de plano, chave em query e trial_end com
 * menos de 48 h dão 400.
 *
 * Páginas humanas: /checkout/:id, /fatura/:id (o "Pagar agora") e /portal/:cliente.
 * Controle do teste: `cobrarAgora`, `atrasar` e `enviarAvisoForjado`.
 * O dialeto Asaas mora em /v3 e /i/:cobranca do MESMO servidor (provedor-de-cobranca-asaas.ts).
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { criarDialetoAsaas, type DubleAsaas } from "./provedor-de-cobranca-asaas";

const VERSAO_MINIMA = "2025-03-31";
const DIA_EM_S = 86_400;
const TERMINAIS = new Set(["canceled", "incomplete_expired"]);

type Intervalo = "month" | "year";

export interface AssinaturaDoDuble {
  id: string;
  customer: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  created: number;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  ended_at: number | null;
  current_period_start: number;
  current_period_end: number;
  product: string;
  unit_amount: number;
  interval: Intervalo;
  metadata: Record<string, string>;
  proration_behavior: string | null;
}
interface FaturaDoDuble {
  id: string; customer: string; subscription: string; status: "open" | "paid";
  amount_due: number; amount_paid: number; created: number; paid_at: number | null;
}
interface SessaoDoDuble {
  id: string; customer: string; client_reference_id: string | null; success_url: string; cancel_url: string;
  product: string; unit_amount: number; interval: Intervalo; trial_end: number | null;
  metadata: Record<string, string>; status: "open" | "complete"; subscription: string | null; expires_at: number;
}
interface ClienteDoDuble { id: string; email: string; name: string; organizacao: string | null }
interface EndpointDoDuble { id: string; url: string; secret: string; eventos: string[]; marca: string }

export interface ChamadaRegistrada {
  metodo: string; caminho: string; query: Record<string, string>; corpo: Record<string, string>;
  autorizacao: string | null; versao: string | null; idempotencia: string | null;
}
export interface AvisoEntregue { eventoId: string; tipo: string; status: number }

export interface ProvedorDeCobrancaFalso {
  readonly base: string;
  readonly chamadas: readonly ChamadaRegistrada[];
  readonly avisos: readonly AvisoEntregue[];
  readonly falhas: readonly string[];
  urlDoWebhook(): string | null;
  segredoDoWebhook(): string | null;
  clienteDaOrg(orgId: string): string | null;
  assinaturaPrincipal(cliente: string): AssinaturaDoDuble | null;
  /** Encerra o teste grátis e paga a 1ª cobrança (a "virada paga"). */
  cobrarAgora(cliente: string): Promise<void>;
  /** A cobrança do período falha: past_due + fatura aberta. Devolve a URL da fatura. */
  atrasar(cliente: string): Promise<string>;
  /** Aviso com assinatura errada; devolve o status HTTP que o app respondeu. */
  enviarAvisoForjado(cliente: string): Promise<number>;
  /** O dialeto Asaas, em /v3 do mesmo servidor. */
  readonly asaas: DubleAsaas;
  fechar(): Promise<void>;
}

/** O cabeçalho que a Stripe manda: `t=<s>,v1=<hex>`, HMAC da string `${t}.${corpo}`. */
export function assinarAviso(segredo: string, corpo: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", segredo).update(`${t}.${corpo}`, "utf8").digest("hex")}`;
}

/** A porta que o SERVIDOR sob teste espera (vem do `.env.e2e`). */
export function portaDoDubleDaCobranca(): number {
  const bruto = process.env.COBRANCA_API_BASE_URL_TESTE ?? "";
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    throw new Error(`COBRANCA_API_BASE_URL_TESTE ausente ou inválida (${JSON.stringify(bruto)}): rode pnpm e2e:env.`);
  }
  if (url.hostname !== "127.0.0.1" || url.port === "") {
    throw new Error("COBRANCA_API_BASE_URL_TESTE precisa ser http://127.0.0.1:<porta>.");
  }
  return Number(url.port);
}

const agoraS = () => Math.floor(Date.now() / 1000);
const novoId = (prefixo: string) => `${prefixo}_test_${randomBytes(8).toString("hex")}`;
const periodo = (i: Intervalo) => (i === "year" ? 365 : 30) * DIA_EM_S;
const reais = (centavos: number) => `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapar = (texto: string) => texto.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

async function lerCorpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = [];
  for await (const parte of req) partes.push(parte as Buffer);
  return Buffer.concat(partes).toString("utf8");
}
function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}
function erroDaApi(res: ServerResponse, status: number, mensagem: string, codigo?: string): void {
  json(res, status, { error: { type: "invalid_request_error", message: mensagem, ...(codigo ? { code: codigo } : {}) } });
}
function pagina(res: ServerResponse, status: number, titulo: string, corpo: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head><body><h1>${titulo}</h1>${corpo}</body></html>`);
}

export async function subirProvedorDeCobranca(opcoes: { porta: number }): Promise<ProvedorDeCobrancaFalso> {
  let base = "";
  let ultimaVersao = VERSAO_MINIMA;
  let endpoint: EndpointDoDuble | null = null;
  let relogio = 0;
  const chamadas: ChamadaRegistrada[] = [];
  const avisos: AvisoEntregue[] = [];
  const falhas: string[] = [];
  const clientes = new Map<string, ClienteDoDuble>();
  const produtos = new Map<string, string>();
  const sessoes = new Map<string, SessaoDoDuble>();
  const assinaturas = new Map<string, AssinaturaDoDuble>();
  const faturas = new Map<string, FaturaDoDuble>();
  const portais: Array<{ id: string; marca: string }> = [];
  const retornosDoPortal = new Map<string, string>();
  const asaas = criarDialetoAsaas(() => base);

  const criadoEm = () => (relogio = Math.max(relogio + 1, agoraS()));
  const itemDe = (a: AssinaturaDoDuble) => a.id.replace(/^sub_/, "si_");
  const objCliente = (c: ClienteDoDuble) => ({
    id: c.id, object: "customer", email: c.email, name: c.name,
    metadata: c.organizacao ? { organization_id: c.organizacao } : {},
  });
  const objPortal = (c: { id: string; marca: string }) => ({
    id: c.id, object: "billing_portal.configuration", active: true, metadata: { cobranca_do_revendedor: c.marca },
  });
  const objAssinatura = (a: AssinaturaDoDuble) => ({
    id: a.id, object: "subscription", customer: a.customer, status: a.status, created: a.created,
    cancel_at_period_end: a.cancel_at_period_end, trial_end: a.trial_end, ended_at: a.ended_at, livemode: false,
    metadata: a.metadata,
    items: { object: "list", has_more: false, data: [{
      id: itemDe(a), object: "subscription_item", quantity: 1,
      current_period_start: a.current_period_start, current_period_end: a.current_period_end,
      price: { id: a.id.replace(/^sub_/, "price_"), object: "price", product: a.product, unit_amount: a.unit_amount,
        currency: "brl", recurring: { interval: a.interval, interval_count: 1 } },
    }] },
  });
  const objFatura = (f: FaturaDoDuble) => ({
    id: f.id, object: "invoice", customer: f.customer, status: f.status, currency: "brl",
    amount_due: f.amount_due, amount_paid: f.amount_paid, created: f.created, livemode: false,
    hosted_invoice_url: `${base}/fatura/${f.id}`, status_transitions: { paid_at: f.paid_at },
    parent: { type: "subscription_details", subscription_details: { subscription: f.subscription, metadata: {} } },
  });
  const objSessao = (s: SessaoDoDuble) => ({
    id: s.id, object: "checkout.session", mode: "subscription", status: s.status, customer: s.customer,
    client_reference_id: s.client_reference_id, subscription: s.subscription, livemode: false, metadata: s.metadata,
    url: s.status === "open" ? `${base}/checkout/${s.id}` : null, expires_at: s.expires_at,
  });
  const objEndpoint = (e: EndpointDoDuble, comSegredo: boolean) => ({
    id: e.id, object: "webhook_endpoint", url: e.url, enabled_events: e.eventos, status: "enabled", livemode: false,
    metadata: { cobranca_do_revendedor: e.marca },
    ...(comSegredo ? { secret: e.secret } : {}),
  });
  const lista = (dados: unknown[], url: string) => ({ object: "list", data: dados, has_more: false, url });
  const doCliente = (cliente: string) =>
    [...assinaturas.values()].filter((a) => a.customer === cliente).sort((x, y) => y.created - x.created);
  const principal = (cliente: string) => doCliente(cliente).find((a) => !TERMINAIS.has(a.status)) ?? null;

  async function enviar(tipo: string, objeto: unknown): Promise<void> {
    if (!endpoint) throw new Error(`aviso ${tipo} sem webhook registrado: o app ainda não conectou o provedor`);
    const evento = { id: novoId("evt"), object: "event", api_version: ultimaVersao, created: agoraS(), livemode: false, type: tipo, data: { object: objeto } };
    const corpo = JSON.stringify(evento);
    const resposta = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": assinarAviso(endpoint.secret, corpo, agoraS()) },
      body: corpo,
    });
    avisos.push({ eventoId: evento.id, tipo, status: resposta.status });
    if (!resposta.ok) throw new Error(`o app respondeu ${resposta.status} ao aviso ${tipo}: ${(await resposta.text()).slice(0, 300)}`);
  }

  function novaFatura(a: AssinaturaDoDuble, valor: number): FaturaDoDuble {
    const f: FaturaDoDuble = { id: novoId("in"), customer: a.customer, subscription: a.id, status: "open", amount_due: valor, amount_paid: 0, created: criadoEm(), paid_at: null };
    faturas.set(f.id, f);
    return f;
  }

  async function pagarFatura(f: FaturaDoDuble): Promise<void> {
    const agora = agoraS();
    f.status = "paid";
    f.amount_paid = f.amount_due;
    f.paid_at = agora;
    const a = assinaturas.get(f.subscription);
    if (a && !TERMINAIS.has(a.status)) {
      a.status = "active";
      a.trial_end = null;
      a.current_period_start = agora;
      a.current_period_end = agora + periodo(a.interval);
    }
    await enviar("invoice.paid", objFatura(f));
    if (a) await enviar("customer.subscription.updated", objAssinatura(a));
  }

  async function concluirCheckout(s: SessaoDoDuble): Promise<void> {
    if (s.status === "complete") return;
    const agora = criadoEm();
    const fimDoTeste = s.trial_end !== null && s.trial_end > agoraS() ? s.trial_end : null;
    const a: AssinaturaDoDuble = {
      id: novoId("sub"), customer: s.customer, status: fimDoTeste ? "trialing" : "active", created: agora,
      cancel_at_period_end: false, trial_end: fimDoTeste, ended_at: null, current_period_start: agora,
      current_period_end: fimDoTeste ?? agora + periodo(s.interval), product: s.product, unit_amount: s.unit_amount,
      interval: s.interval, metadata: s.metadata, proration_behavior: null,
    };
    assinaturas.set(a.id, a);
    // Com teste grátis, a Stripe emite fatura de R$ 0 paga — ela NÃO conta como pagamento (§6.1 passo 5).
    const f = novaFatura(a, fimDoTeste ? 0 : s.unit_amount);
    f.status = "paid";
    f.amount_paid = f.amount_due;
    f.paid_at = agoraS();
    s.status = "complete";
    s.subscription = a.id;
    await enviar("checkout.session.completed", objSessao(s));
    await enviar("customer.subscription.created", objAssinatura(a));
    await enviar("invoice.paid", objFatura(f));
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, bruto: string): Promise<void> {
    const metodo = req.method ?? "GET";
    const cab = (nome: string) => (typeof req.headers[nome] === "string" ? (req.headers[nome] as string) : null);
    const autorizacao = cab("authorization");
    const versao = cab("stripe-version");
    const idempotencia = cab("idempotency-key");
    const pares = [...new URLSearchParams(bruto)];
    const corpo: Record<string, string> = Object.fromEntries(pares);
    const query: Record<string, string> = Object.fromEntries(url.searchParams);
    const p = url.pathname;
    chamadas.push({ metodo, caminho: p, query, corpo, autorizacao, versao, idempotencia });

    const chave = autorizacao?.startsWith("Bearer ") ? autorizacao.slice(7) : "";
    if (!/^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(chave)) return erroDaApi(res, 401, "Invalid API Key provided");
    if (Object.values(query).some((v) => /(sk|rk)_(test|live)_/.test(v))) return erroDaApi(res, 400, "chave de API em query string");
    if (!versao || versao.slice(0, 10) < VERSAO_MINIMA) return erroDaApi(res, 400, `Stripe-Version ausente ou anterior a ${VERSAO_MINIMA}`);
    if (metodo === "POST" && !idempotencia) return erroDaApi(res, 400, "POST sem Idempotency-Key (spec §6.1)");
    ultimaVersao = versao;

    if (metodo === "GET" && p === "/v1/customers") {
      return json(res, 200, lista([...clientes.values()].slice(0, Number(query.limit ?? "10")).map(objCliente), p));
    }
    const clienteUnico = /^\/v1\/customers\/(cus_[^/]+)$/.exec(p);
    if (metodo === "GET" && clienteUnico) {
      const c = clientes.get(clienteUnico[1] ?? "");
      return c ? json(res, 200, objCliente(c)) : erroDaApi(res, 404, `No such customer: ${clienteUnico[1]}`, "resource_missing");
    }
    if (metodo === "GET" && p === "/v1/customers/search") {
      const org = /metadata\['organization_id'\]:'([0-9a-f-]{36})'/.exec(query.query ?? "")?.[1];
      const achados = [...clientes.values()].filter((c) => org !== undefined && c.organizacao === org);
      return json(res, 200, { object: "search_result", data: achados.map(objCliente), has_more: false, url: p });
    }
    if (metodo === "GET" && p === "/v1/webhook_endpoints") return json(res, 200, lista(endpoint ? [objEndpoint(endpoint, false)] : [], p));
    if (metodo === "POST" && p === "/v1/webhook_endpoints") {
      const eventos = pares.filter(([k]) => /^enabled_events\[\d*\]$/.test(k)).map(([, v]) => v);
      const destino = corpo.url ?? "";
      if (destino === "" || eventos.length === 0) return erroDaApi(res, 400, "url e enabled_events obrigatórios");
      if (eventos.includes("invoice.created")) return erroDaApi(res, 400, "invoice.created é proibido (spec §6.1)");
      endpoint = {
        id: novoId("we"), url: destino, secret: `whsec_${randomBytes(24).toString("hex")}`, eventos,
        marca: corpo["metadata[cobranca_do_revendedor]"] ?? "",
      };
      return json(res, 200, objEndpoint(endpoint, true));
    }
    let achado = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(p);
    if (metodo === "DELETE" && achado) {
      if (endpoint?.id === achado[1]) endpoint = null;
      return json(res, 200, { id: achado[1], object: "webhook_endpoint", deleted: true });
    }
    if (metodo === "GET" && p === "/v1/billing_portal/configurations") return json(res, 200, lista(portais.map(objPortal), p));
    if (metodo === "POST" && (p === "/v1/billing_portal/configurations" || p.startsWith("/v1/billing_portal/configurations/"))) {
      if (corpo["features[subscription_update][enabled]"] === "true") return erroDaApi(res, 400, "o portal não troca de plano (spec §5)");
      const existente = p.split("/")[4];
      const atual = portais.find((c) => c.id === existente);
      if (existente !== undefined && atual === undefined) return erroDaApi(res, 404, `No such configuration: ${existente}`, "resource_missing");
      const configuracao = atual ?? { id: novoId("bpc"), marca: corpo["metadata[cobranca_do_revendedor]"] ?? "" };
      if (atual === undefined) portais.push(configuracao);
      return json(res, 200, objPortal(configuracao));
    }
    if (metodo === "POST" && p === "/v1/customers") {
      const c: ClienteDoDuble = { id: novoId("cus"), email: corpo.email ?? "", name: corpo.name ?? "", organizacao: corpo["metadata[organization_id]"] ?? null };
      clientes.set(c.id, c);
      return json(res, 200, objCliente(c));
    }
    if (metodo === "POST" && p === "/v1/products") {
      const idDoProduto = corpo.id ?? novoId("prod");
      if (produtos.has(idDoProduto)) return erroDaApi(res, 400, `Product already exists: ${idDoProduto}`, "resource_already_exists");
      produtos.set(idDoProduto, corpo.name ?? idDoProduto);
      return json(res, 200, { id: idDoProduto, object: "product", name: produtos.get(idDoProduto) });
    }
    achado = /^\/v1\/products\/([^/]+)$/.exec(p);
    if (metodo === "POST" && achado) {
      const idDoProduto = achado[1] ?? "";
      if (!produtos.has(idDoProduto)) return erroDaApi(res, 404, `No such product: ${idDoProduto}`, "resource_missing");
      produtos.set(idDoProduto, corpo.name ?? produtos.get(idDoProduto) ?? idDoProduto);
      return json(res, 200, { id: idDoProduto, object: "product", name: produtos.get(idDoProduto), active: corpo.active !== "false" });
    }
    if (metodo === "POST" && p === "/v1/checkout/sessions") {
      const cliente = corpo.customer ?? "";
      const valor = Number(corpo["line_items[0][price_data][unit_amount]"]);
      const intervalo = corpo["line_items[0][price_data][recurring][interval]"];
      const produto = corpo["line_items[0][price_data][product]"] ?? "";
      const sucesso = corpo.success_url ?? "";
      const cancela = corpo.cancel_url ?? "";
      if (corpo.mode !== "subscription" || !clientes.has(cliente) || corpo["line_items[0][price_data][currency]"] !== "brl"
        || !Number.isInteger(valor) || valor < 500 || (intervalo !== "month" && intervalo !== "year")
        || !produtos.has(produto) || sucesso === "" || cancela === "") {
        return erroDaApi(res, 400, "sessão fora do contrato de §6.1 (mode, customer, price_data brl ≥ 500, recurring, product, success_url, cancel_url)");
      }
      const fim = corpo["subscription_data[trial_end]"];
      const fimDoTeste = fim === undefined ? null : Number(fim);
      if (fimDoTeste !== null && fimDoTeste - agoraS() < 48 * 3600) return erroDaApi(res, 400, "trial_end com menos de 48 h");
      const prefixo = "subscription_data[metadata][";
      const metadata = Object.fromEntries(pares.filter(([k]) => k.startsWith(prefixo)).map(([k, v]) => [k.slice(prefixo.length, -1), v]));
      const s: SessaoDoDuble = {
        id: novoId("cs"), customer: cliente, client_reference_id: corpo.client_reference_id ?? null, success_url: sucesso,
        cancel_url: cancela, product: produto, unit_amount: valor, interval: intervalo, trial_end: fimDoTeste, metadata,
        status: "open", subscription: null, expires_at: agoraS() + DIA_EM_S,
      };
      sessoes.set(s.id, s);
      return json(res, 200, objSessao(s));
    }
    if (metodo === "GET" && p === "/v1/subscriptions") {
      const status = query.status ?? "active";
      const todas = doCliente(query.customer ?? "");
      const filtradas = status === "all" ? todas : todas.filter((a) => a.status === status);
      return json(res, 200, lista(filtradas.slice(0, Number(query.limit ?? "10")).map(objAssinatura), p));
    }
    achado = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
    if (achado) {
      const a = assinaturas.get(achado[1] ?? "");
      if (!a) return erroDaApi(res, 404, `No such subscription: ${achado[1]}`, "resource_missing");
      if (metodo === "GET") return json(res, 200, objAssinatura(a));
      if (corpo.cancel_at_period_end !== undefined) a.cancel_at_period_end = corpo.cancel_at_period_end === "true";
      const novoValor = corpo["items[0][price_data][unit_amount]"];
      if (novoValor !== undefined) {
        if (corpo["items[0][id]"] !== itemDe(a)) return erroDaApi(res, 400, "items[0][id] não é o item desta assinatura");
        a.unit_amount = Number(novoValor);
        a.product = corpo["items[0][price_data][product]"] ?? a.product;
        a.proration_behavior = corpo.proration_behavior ?? null;
      }
      await enviar("customer.subscription.updated", objAssinatura(a));
      return json(res, 200, objAssinatura(a));
    }
    if (metodo === "GET" && p === "/v1/invoices") {
      const dados = [...faturas.values()]
        .filter((f) => (!query.customer || f.customer === query.customer)
          && (!query.subscription || f.subscription === query.subscription)
          && (!query.status || f.status === query.status))
        .sort((x, y) => y.created - x.created);
      return json(res, 200, lista(dados.slice(0, Number(query.limit ?? "10")).map(objFatura), p));
    }
    if (metodo === "POST" && p === "/v1/billing_portal/sessions") {
      const cliente = corpo.customer ?? "";
      if (!clientes.has(cliente)) return erroDaApi(res, 404, `No such customer: ${cliente}`, "resource_missing");
      retornosDoPortal.set(cliente, corpo.return_url ?? "");
      return json(res, 200, { id: novoId("bps"), object: "billing_portal.session", customer: cliente, url: `${base}/portal/${cliente}`, return_url: corpo.return_url ?? null });
    }
    return erroDaApi(res, 404, `rota não implementada no dublê: ${metodo} ${p}`);
  }

  async function paginas(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const post = req.method === "POST";
    let achado = /^\/checkout\/([^/]+)(\/pagar)?$/.exec(url.pathname);
    if (achado) {
      const s = sessoes.get(achado[1] ?? "");
      if (!s) return pagina(res, 404, "Checkout não encontrado", "<p>Sessão desconhecida.</p>");
      if (post && achado[2]) {
        await concluirCheckout(s);
        res.writeHead(303, { location: s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id) });
        return void res.end();
      }
      return pagina(res, 200, "Checkout de teste",
        `<p>${escapar(produtos.get(s.product) ?? s.product)}</p><p>${reais(s.unit_amount)} por ${s.interval === "year" ? "ano" : "mês"}</p>`
        + `<form method="post" action="/checkout/${s.id}/pagar"><button type="submit">Pagar com cartão de teste</button></form>`
        + `<p><a href="${escapar(s.cancel_url)}">Voltar sem pagar</a></p>`);
    }
    achado = /^\/fatura\/([^/]+)(\/pagar)?$/.exec(url.pathname);
    if (achado) {
      const f = faturas.get(achado[1] ?? "");
      if (!f) return pagina(res, 404, "Fatura não encontrada", "<p>Fatura desconhecida.</p>");
      if (post && achado[2]) {
        if (f.status === "open") await pagarFatura(f);
        res.writeHead(303, { location: `/fatura/${f.id}` });
        return void res.end();
      }
      return pagina(res, 200, "Fatura de teste", f.status === "paid"
        ? `<p>${reais(f.amount_paid)}</p><p>Fatura paga</p>`
        : `<p>${reais(f.amount_due)}</p><form method="post" action="/fatura/${f.id}/pagar"><button type="submit">Pagar fatura</button></form>`);
    }
    achado = /^\/portal\/([^/]+)$/.exec(url.pathname);
    if (achado) {
      const volta = retornosDoPortal.get(achado[1] ?? "") ?? "";
      return pagina(res, 200, "Portal de teste", `<p>Trocar cartão e ver faturas.</p>${volta ? `<p><a href="${escapar(volta)}">Voltar ao sistema</a></p>` : ""}`);
    }
    return pagina(res, 404, "Não encontrado", "<p>Rota desconhecida do dublê.</p>");
  }

  const servidor = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      const bruto = await lerCorpo(req);
      if (url.pathname.startsWith("/v1/")) return api(req, res, url, bruto);
      if (url.pathname.startsWith("/v3/")) return asaas.api(req, res, url, bruto);
      if (url.pathname.startsWith("/i/")) return asaas.pagina(req, res, url);
      return paginas(req, res, url);
    })().catch((erro: unknown) => {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      falhas.push(mensagem);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dublê do provedor de cobrança: ${mensagem}`);
    });
  });
  await new Promise<void>((ok, falhou) => {
    servidor.once("error", falhou);
    servidor.listen(opcoes.porta, "127.0.0.1", () => ok());
  });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  return {
    get base() { return base; },
    chamadas,
    avisos,
    falhas,
    asaas: asaas.controle,
    urlDoWebhook: () => endpoint?.url ?? null,
    segredoDoWebhook: () => endpoint?.secret ?? null,
    clienteDaOrg: (orgId) => [...clientes.values()].find((c) => c.organizacao === orgId)?.id ?? null,
    assinaturaPrincipal: principal,
    async cobrarAgora(cliente) {
      const a = principal(cliente);
      if (!a) throw new Error(`cliente ${cliente} sem assinatura viva no dublê`);
      await pagarFatura(novaFatura(a, a.unit_amount));
    },
    async atrasar(cliente) {
      const a = principal(cliente);
      if (!a) throw new Error(`cliente ${cliente} sem assinatura viva no dublê`);
      a.status = "past_due";
      const f = novaFatura(a, a.unit_amount);
      await enviar("invoice.payment_failed", objFatura(f));
      await enviar("customer.subscription.updated", objAssinatura(a));
      return `${base}/fatura/${f.id}`;
    },
    async enviarAvisoForjado(cliente) {
      if (!endpoint) throw new Error("sem webhook registrado");
      const corpo = JSON.stringify({ id: novoId("evt"), object: "event", type: "invoice.paid", created: agoraS(), livemode: false,
        data: { object: { object: "invoice", customer: cliente, status: "paid", amount_paid: 1 } } });
      const r = await fetch(endpoint.url, { method: "POST", body: corpo,
        headers: { "content-type": "application/json", "stripe-signature": assinarAviso(`whsec_${randomBytes(24).toString("hex")}`, corpo, agoraS()) } });
      return r.status;
    },
    fechar: () => new Promise<void>((ok) => { servidor.closeAllConnections(); servidor.close(() => ok()); }),
  };
}
