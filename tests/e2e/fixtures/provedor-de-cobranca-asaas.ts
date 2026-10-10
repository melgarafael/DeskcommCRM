/**
 * Dialeto Asaas do dublê de cobrança do e2e (spec da cobrança §6.2). Mora no
 * MESMO servidor do dublê da Stripe (provedor-de-cobranca.ts), em /v3, porque o
 * app tira as duas bases de UMA variável (COBRANCA_API_BASE_URL_TESTE): Stripe
 * em <base>/v1, Asaas em <base>/v3.
 *
 * Fala o subconjunto que lib/cobranca/provedores/asaas.ts usa, nas formas do
 * Asaas: JSON, valor em REAIS, datas civis "AAAA-MM-DD", listas
 * {object,hasMore,totalCount,limit,offset,data} e erro {errors:[{code,description}]}.
 * É MAIS estrito que o Asaas onde a spec é: chave fora do cabeçalho access_token,
 * User-Agent ausente ou o padrão do Node, chave de produção, CPF/CNPJ com máscara
 * ou dígito errado, billingType que não seja UNDEFINED, valor abaixo de R$ 5 e
 * PUT sem updatePendingPayments:true dão erro.
 *
 * Imita o que a spec diz que o Asaas faz e que o adaptador precisa aguentar:
 *  - a assinatura nasce ACTIVE antes de qualquer pagamento (ACTIVE não é "existe");
 *  - NA CRIAÇÃO nasce só a 1ª cobrança (medido no sandbox, com 1º vencimento hoje
 *    e a 35 dias: 1 cobrança nas duas); as seguintes nascem até 40 dias antes de
 *    vencer, depois de um pagamento (cadência de fundo NÃO medida), e `nextDueDate`
 *    fica um ciclo ALÉM do período pago (proximoVencimento NÃO é nextDueDate);
 *  - a assinatura removida some da lista sem `includeDeleted=true`;
 *  - o aviso leva só o token estático em `asaas-access-token`, sem assinatura.
 * Páginas humanas: /i/:cobranca (a invoiceUrl), com Pix e cartão de teste.
 * Controle do teste: `pagar`, `vencer`, `recusarCriacaoDeWebhook`,
 * `enviarAvisoForjado` (token errado) e `enviarAvisoMentiroso` (token CERTO,
 * corpo que jura "pago": o token vazou).
 */
import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const FUSO = "America/Sao_Paulo";
/** Padrão do Asaas: cada cobrança nasce 40 dias antes de vencer (spec §6.2, passo 5). */
const ANTECEDENCIA_DIAS = 40;
const DIA_MS = 86_400_000;
/** Eventos que o webhook do Asaas aceita (o subconjunto que importa aqui). */
const EVENTOS_CONHECIDOS = new Set([
  "PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE",
  "PAYMENT_DELETED", "PAYMENT_RESTORED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED",
  "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_DELETED",
]);

export type CicloAsaas = "MONTHLY" | "YEARLY";

export interface AssinaturaAsaas {
  id: string;
  customer: string;
  value: number;
  cycle: CicloAsaas;
  /** Vencimento da PRÓXIMA cobrança ainda não gerada — não é o fim do período pago. */
  nextDueDate: string;
  description: string;
  externalReference: string | null;
  status: "ACTIVE" | "INACTIVE" | "EXPIRED";
  deleted: boolean;
  dateCreated: string;
  ordem: number;
}
export interface CobrancaAsaas {
  id: string;
  customer: string;
  subscription: string;
  value: number;
  status: "PENDING" | "OVERDUE" | "CONFIRMED" | "RECEIVED";
  dueDate: string;
  billingType: "UNDEFINED" | "PIX" | "CREDIT_CARD";
  paymentDate: string | null;
  confirmedDate: string | null;
  deleted: boolean;
  dateCreated: string;
  ordem: number;
}
interface ClienteAsaas { id: string; name: string; email: string; cpfCnpj: string; externalReference: string | null }
interface WebhookAsaas { id: string; name: string; url: string; email: string; authToken: string; events: string[] }

export interface ChamadaAsaas {
  metodo: string;
  caminho: string;
  query: Record<string, string>;
  corpo: Record<string, unknown> | null;
  chave: string | null;
  userAgent: string | null;
  contentType: string | null;
}
export interface AvisoAsaasEntregue { eventoId: string; evento: string; status: number }

export interface DubleAsaas {
  readonly chamadas: readonly ChamadaAsaas[];
  readonly avisos: readonly AvisoAsaasEntregue[];
  urlDoWebhook(): string | null;
  tokenDoWebhook(): string | null;
  eventosDoWebhook(): readonly string[];
  clienteDaOrg(orgId: string): string | null;
  /** Cobranças não removidas do cliente, por vencimento. */
  cobrancasDe(cliente: string): readonly CobrancaAsaas[];
  /** Assinaturas do cliente, inclusive as removidas, a mais recente primeiro. */
  assinaturasDe(cliente: string): readonly AssinaturaAsaas[];
  /** true = POST /v3/webhooks recusa (conta sem permissão): o app cai no passo a passo manual. */
  recusarCriacaoDeWebhook(recusar: boolean): void;
  /** Paga como o pagador faria na invoiceUrl. Pix → RECEIVED; cartão → CONFIRMED. */
  pagar(cobranca: string, forma: "pix" | "cartao"): Promise<void>;
  /** A pendente mais antiga venceu ontem sem pagamento: OVERDUE. Devolve a invoiceUrl dela. */
  vencer(cliente: string): Promise<string>;
  /** Aviso com token errado; devolve o status HTTP que o app respondeu. */
  enviarAvisoForjado(cliente: string): Promise<number>;
  /** Aviso com o token CERTO e corpo que jura "pago" (o token vazou); devolve o status HTTP. */
  enviarAvisoMentiroso(cliente: string): Promise<number>;
}

export interface DialetoAsaas {
  api(req: IncomingMessage, res: ServerResponse, url: URL, bruto: string): Promise<void>;
  pagina(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  readonly controle: DubleAsaas;
}

const diaCivil = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
/** A data civil em São Paulo ("AAAA-MM-DD"): é o "hoje" do Asaas. */
export const hojeEmSaoPaulo = (agora: Date = new Date()): string => diaCivil.format(agora);
const somarDias = (data: string, dias: number): string =>
  new Date(Date.parse(`${data}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);

/**
 * Um ciclo depois, no calendário (31/01 + 1 mês = último dia de fevereiro).
 * ponytail: a regra do Asaas para o dia 31 não foi medida; o smoke (scripts/smoke-asaas.ts) compara a do dia.
 */
export function somarCiclo(data: string, ciclo: CicloAsaas): string {
  const [ano = 0, mes = 1, dia = 1] = data.split("-").map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + (ciclo === "YEARLY" ? 12 : 1), 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimo));
  return alvo.toISOString().slice(0, 10);
}

const PESOS_CPF_1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CPF_2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
function digitoVerificador(digitos: number[], pesos: number[]): number {
  const resto = digitos.reduce((soma, d, i) => soma + d * (pesos[i] ?? 0), 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}
/** O oráculo do dublê, independente do adaptador: CPF (11) ou CNPJ (14) só com dígitos, verificadores certos, sem repetir um dígito só. */
export function documentoValido(doc: string): boolean {
  if (!/^(\d{11}|\d{14})$/.test(doc) || /^(\d)\1+$/.test(doc)) return false;
  const d = [...doc].map(Number);
  const [p1, p2] = doc.length === 11 ? [PESOS_CPF_1, PESOS_CPF_2] : [PESOS_CNPJ_1, PESOS_CNPJ_2];
  const n = d.length - 2;
  return digitoVerificador(d.slice(0, n), p1) === d[n] && digitoVerificador(d.slice(0, n + 1), p2) === d[n + 1];
}
function completar(base: number[], p1: number[], p2: number[]): string {
  const um = digitoVerificador(base, p1);
  return [...base, um, digitoVerificador([...base, um], p2)].join("");
}
const aleatorios = (n: number) => Array.from({ length: n }, () => randomInt(10));
/** CPF de teste com verificador certo, gerado agora (nunca um número fixo de alguém). */
export const gerarCpf = (): string => completar(aleatorios(9), PESOS_CPF_1, PESOS_CPF_2);
/** CNPJ de teste (matriz 0001) com verificador certo, gerado agora. */
export const gerarCnpj = (): string => completar([...aleatorios(8), 0, 0, 0, 1], PESOS_CNPJ_1, PESOS_CNPJ_2);

const texto = (v: unknown): string => (typeof v === "string" ? v : "");
const emReais = (v: number) => Number.isFinite(v) && v >= 5 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const reais = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;
const dataBr = (d: string) => d.split("-").reverse().join("/");

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}
function erro(res: ServerResponse, status: number, code: string, description: string): void {
  json(res, status, { errors: [{ code, description }] });
}
function paginaHtml(res: ServerResponse, status: number, titulo: string, corpo: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head><body><h1>${titulo}</h1>${corpo}</body></html>`);
}

export function criarDialetoAsaas(baseAtual: () => string): DialetoAsaas {
  let ordem = 0;
  let recusarWebhook = false;
  const chamadas: ChamadaAsaas[] = [];
  const avisos: AvisoAsaasEntregue[] = [];
  const clientes = new Map<string, ClienteAsaas>();
  const assinaturas = new Map<string, AssinaturaAsaas>();
  const cobrancas = new Map<string, CobrancaAsaas>();
  const webhooks: WebhookAsaas[] = [];

  const proxima = () => (ordem += 1);
  const novoId = (prefixo: string) => `${prefixo}_${randomBytes(6).toString("hex")}`;
  const urlDaFatura = (c: CobrancaAsaas) => `${baseAtual()}/i/${c.id}`;
  const lista = (dados: unknown[], q: Record<string, string>) => {
    const offset = Number(q.offset ?? "0");
    const limit = Number(q.limit ?? "10");
    return { object: "list", hasMore: offset + limit < dados.length, totalCount: dados.length, limit, offset, data: dados.slice(offset, offset + limit) };
  };
  const objCliente = (c: ClienteAsaas) => ({
    object: "customer", id: c.id, name: c.name, email: c.email, cpfCnpj: c.cpfCnpj, externalReference: c.externalReference, deleted: false,
  });
  const objAssinatura = (a: AssinaturaAsaas) => ({
    object: "subscription", id: a.id, dateCreated: a.dateCreated, customer: a.customer, billingType: "UNDEFINED", cycle: a.cycle,
    value: a.value, nextDueDate: a.nextDueDate, endDate: null, description: a.description, status: a.status, deleted: a.deleted,
    externalReference: a.externalReference,
  });
  const objCobranca = (c: CobrancaAsaas) => ({
    object: "payment", id: c.id, dateCreated: c.dateCreated, customer: c.customer, subscription: c.subscription, value: c.value,
    netValue: c.value, billingType: c.billingType, status: c.status, dueDate: c.dueDate, originalDueDate: c.dueDate,
    paymentDate: c.paymentDate, clientPaymentDate: c.paymentDate, confirmedDate: c.confirmedDate, invoiceUrl: urlDaFatura(c), deleted: c.deleted,
  });
  const objWebhook = (w: WebhookAsaas) => ({
    object: "webhook", id: w.id, name: w.name, url: w.url, email: w.email, enabled: true, interrupted: false, apiVersion: 3,
    hasAuthToken: true, sendType: "SEQUENTIALLY", events: w.events,
  });
  const porVencimento = (x: CobrancaAsaas, y: CobrancaAsaas) => x.dueDate.localeCompare(y.dueDate) || x.ordem - y.ordem;
  const cobrancasDe = (cliente: string) => [...cobrancas.values()].filter((c) => c.customer === cliente && !c.deleted).sort(porVencimento);
  const daAssinatura = (id: string) => [...cobrancas.values()].filter((c) => c.subscription === id && !c.deleted).sort(porVencimento);
  const assinaturasDe = (cliente: string) => [...assinaturas.values()].filter((a) => a.customer === cliente).sort((x, y) => y.ordem - x.ordem);

  /** Só os eventos que o webhook assinou; o token estático no cabeçalho, como o Asaas manda. */
  async function enviar(evento: string, objeto: { object: string }): Promise<void> {
    const campo = objeto.object === "payment" ? "payment" : "subscription";
    for (const w of webhooks.filter((h) => h.events.includes(evento))) {
      const id = `evt_${randomBytes(16).toString("hex")}&${proxima()}`;
      const corpo = JSON.stringify({ id, event: evento, dateCreated: new Date().toISOString().slice(0, 19).replace("T", " "), [campo]: objeto });
      const r = await fetch(w.url, {
        method: "POST",
        headers: { "content-type": "application/json", "asaas-access-token": w.authToken, "user-agent": "Asaas_Hmlg/3.0" },
        body: corpo,
      });
      avisos.push({ eventoId: id, evento, status: r.status });
      if (!r.ok) throw new Error(`o app respondeu ${r.status} ao aviso ${evento}: ${(await r.text()).slice(0, 300)}`);
    }
  }

  /** Gera as cobranças que vencem em até 40 dias; na criação, só a 1ª (o que o sandbox fez). */
  async function gerarDevidas(a: AssinaturaAsaas, soAPrimeira = false): Promise<void> {
    const limite = soAPrimeira ? a.nextDueDate : somarDias(hojeEmSaoPaulo(), ANTECEDENCIA_DIAS);
    while (!a.deleted && a.status === "ACTIVE" && a.nextDueDate <= limite) {
      const c: CobrancaAsaas = {
        id: novoId("pay"), customer: a.customer, subscription: a.id, value: a.value, status: "PENDING", dueDate: a.nextDueDate,
        billingType: "UNDEFINED", paymentDate: null, confirmedDate: null, deleted: false, dateCreated: hojeEmSaoPaulo(), ordem: proxima(),
      };
      cobrancas.set(c.id, c);
      a.nextDueDate = somarCiclo(a.nextDueDate, a.cycle);
      await enviar("PAYMENT_CREATED", objCobranca(c));
    }
  }

  async function pagar(id: string, forma: "pix" | "cartao"): Promise<void> {
    const c = cobrancas.get(id);
    if (!c || c.deleted) throw new Error(`cobrança ${id} não existe no dublê`);
    if (c.status !== "PENDING" && c.status !== "OVERDUE") return;
    const hoje = hojeEmSaoPaulo();
    c.status = forma === "pix" ? "RECEIVED" : "CONFIRMED";
    c.billingType = forma === "pix" ? "PIX" : "CREDIT_CARD";
    c.confirmedDate = hoje;
    c.paymentDate = forma === "pix" ? hoje : null;
    await enviar(forma === "pix" ? "PAYMENT_RECEIVED" : "PAYMENT_CONFIRMED", objCobranca(c));
    const a = assinaturas.get(c.subscription);
    if (a) await gerarDevidas(a);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, bruto: string): Promise<void> {
    const metodo = req.method ?? "GET";
    const cab = (nome: string) => (typeof req.headers[nome] === "string" ? (req.headers[nome] as string) : null);
    const query: Record<string, string> = Object.fromEntries(url.searchParams);
    let corpo: Record<string, unknown> | null = null;
    try {
      const lido: unknown = bruto === "" ? null : JSON.parse(bruto);
      corpo = lido !== null && typeof lido === "object" && !Array.isArray(lido) ? (lido as Record<string, unknown>) : null;
    } catch {
      corpo = null;
    }
    const p = url.pathname;
    const chave = cab("access_token");
    const userAgent = cab("user-agent");
    const contentType = cab("content-type");
    chamadas.push({ metodo, caminho: p, query, corpo, chave, userAgent, contentType });

    if (url.search.includes("aact_") || "access_token" in query) return erro(res, 400, "invalid_request", "chave de API em query string");
    if (chave?.startsWith("$aact_prod_")) return erro(res, 401, "invalid_environment", "chave de produção no sandbox");
    if (!chave || !/^\$aact_hmlg_\S{8,}$/.test(chave)) return erro(res, 401, "invalid_access_token", "A chave de API fornecida é inválida");
    if (!userAgent || /^(node|undici)\b/i.test(userAgent)) return erro(res, 400, "invalid_user_agent", "o Asaas exige um User-Agent próprio (spec §6.2)");
    if ((metodo === "POST" || metodo === "PUT") && (!contentType?.startsWith("application/json") || corpo === null)) {
      return erro(res, 400, "invalid_body", "corpo JSON obrigatório");
    }
    const c = corpo ?? {};

    if (metodo === "GET" && p === "/v3/customers") {
      const dados = [...clientes.values()].filter((x) => !query.externalReference || x.externalReference === query.externalReference);
      return json(res, 200, lista(dados.map(objCliente), query));
    }
    const clienteUnico = /^\/v3\/customers\/([^/]+)$/.exec(p);
    if (metodo === "GET" && clienteUnico) {
      const x = clientes.get(clienteUnico[1] ?? "");
      return x ? json(res, 200, objCliente(x)) : erro(res, 404, "not_found", "Cliente não encontrado.");
    }
    if (metodo === "POST" && p === "/v3/customers") {
      const nome = texto(c.name).trim();
      const doc = texto(c.cpfCnpj);
      if (nome === "") return erro(res, 400, "invalid_name", "O nome do cliente é obrigatório.");
      if (!documentoValido(doc)) return erro(res, 400, "invalid_cpfCnpj", "O CPF/CNPJ informado é inválido.");
      const x: ClienteAsaas = { id: novoId("cus"), name: nome, email: texto(c.email), cpfCnpj: doc, externalReference: texto(c.externalReference) || null };
      clientes.set(x.id, x);
      return json(res, 200, objCliente(x));
    }

    if (metodo === "GET" && p === "/v3/webhooks") return json(res, 200, lista(webhooks.map(objWebhook), query));
    if (metodo === "POST" && p === "/v3/webhooks") {
      if (recusarWebhook) return erro(res, 403, "insufficient_permission", "A chave não tem permissão para gerenciar webhooks.");
      const eventos = Array.isArray(c.events) ? c.events.filter((e): e is string => typeof e === "string") : [];
      const token = texto(c.authToken);
      const email = texto(c.email);
      const destino = texto(c.url);
      if (destino === "" || email === "") return erro(res, 400, "invalid_webhook", "url e email são obrigatórios.");
      if (eventos.length === 0 || eventos.some((e) => !EVENTOS_CONHECIDOS.has(e))) return erro(res, 400, "invalid_events", "Eventos inválidos.");
      if (token.length < 32 || token.length > 255) return erro(res, 400, "invalid_authToken", "O authToken deve ter de 32 a 255 caracteres.");
      if (c.enabled !== true || c.interrupted !== false || c.sendType !== "SEQUENTIALLY") {
        return erro(res, 400, "invalid_webhook", "a spec manda enabled:true, interrupted:false e sendType SEQUENTIALLY");
      }
      if (webhooks.some((x) => x.url === destino)) return erro(res, 400, "invalid_object", "Já existe um webhook com esta URL.");
      const w: WebhookAsaas = { id: novoId("wh"), name: texto(c.name), url: destino, email, authToken: token, events: eventos };
      webhooks.push(w);
      return json(res, 200, objWebhook(w));
    }
    const webhookUnico = /^\/v3\/webhooks\/([^/]+)$/.exec(p);
    if (metodo === "DELETE" && webhookUnico) {
      const alvo = webhookUnico[1] ?? "";
      const i = webhooks.findIndex((w) => w.id === alvo);
      if (i === -1) return erro(res, 404, "not_found", "Webhook não encontrado.");
      webhooks.splice(i, 1);
      return json(res, 200, { deleted: true, id: alvo });
    }

    if (metodo === "GET" && p === "/v3/subscriptions") {
      const dados = assinaturasDe(query.customer ?? "")
        .filter((a) => query.includeDeleted === "true" || !a.deleted)
        .filter((a) => !query.status || a.status === query.status);
      return json(res, 200, lista(dados.map(objAssinatura), query));
    }
    if (metodo === "POST" && p === "/v3/subscriptions") {
      const cliente = texto(c.customer);
      const valor = typeof c.value === "number" ? c.value : Number.NaN;
      const ciclo: CicloAsaas | null = c.cycle === "MONTHLY" ? "MONTHLY" : c.cycle === "YEARLY" ? "YEARLY" : null;
      const vencimento = texto(c.nextDueDate);
      if (!clientes.has(cliente)) return erro(res, 400, "invalid_customer", "Cliente inexistente.");
      if (c.billingType !== "UNDEFINED") return erro(res, 400, "invalid_billingType", "a spec manda billingType UNDEFINED (o pagador escolhe Pix, boleto ou cartão)");
      if (!emReais(valor)) return erro(res, 400, "invalid_value", "valor em reais, a partir de 5,00, com até 2 casas");
      if (ciclo === null) return erro(res, 400, "invalid_cycle", "ciclo inválido");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento) || vencimento < hojeEmSaoPaulo()) {
        return erro(res, 400, "invalid_nextDueDate", "nextDueDate não pode estar no passado (data civil de São Paulo).");
      }
      const a: AssinaturaAsaas = {
        id: novoId("sub"), customer: cliente, value: valor, cycle: ciclo, nextDueDate: vencimento, description: texto(c.description),
        externalReference: texto(c.externalReference) || null, status: "ACTIVE", deleted: false, dateCreated: hojeEmSaoPaulo(), ordem: proxima(),
      };
      assinaturas.set(a.id, a);
      await gerarDevidas(a, true);
      await enviar("SUBSCRIPTION_CREATED", objAssinatura(a));
      return json(res, 200, objAssinatura(a));
    }
    const assinaturaUnica = /^\/v3\/subscriptions\/([^/]+)(\/payments)?$/.exec(p);
    if (assinaturaUnica) {
      const a = assinaturas.get(assinaturaUnica[1] ?? "");
      if (!a) return erro(res, 404, "not_found", "Assinatura não encontrada.");
      if (assinaturaUnica[2]) {
        return metodo === "GET" ? json(res, 200, lista(daAssinatura(a.id).map(objCobranca), query)) : erro(res, 405, "invalid_request", "só GET");
      }
      if (metodo === "GET") return json(res, 200, objAssinatura(a));
      if (metodo === "PUT") {
        const valor = typeof c.value === "number" ? c.value : Number.NaN;
        if (a.deleted) return erro(res, 400, "invalid_action", "Assinatura removida.");
        if (!emReais(valor)) return erro(res, 400, "invalid_value", "valor em reais, a partir de 5,00, com até 2 casas");
        if (c.updatePendingPayments !== true) return erro(res, 400, "invalid_request", "a spec manda updatePendingPayments:true (§6.2 e §16 3.10)");
        a.value = valor;
        if (typeof c.description === "string") a.description = c.description;
        for (const x of daAssinatura(a.id)) if (x.status === "PENDING") x.value = valor;
        await enviar("SUBSCRIPTION_UPDATED", objAssinatura(a));
        return json(res, 200, objAssinatura(a));
      }
      if (metodo === "DELETE") {
        a.deleted = true;
        const removidas = daAssinatura(a.id).filter((x) => x.status === "PENDING" || x.status === "OVERDUE");
        for (const x of removidas) x.deleted = true;
        await enviar("SUBSCRIPTION_DELETED", objAssinatura(a));
        for (const x of removidas) await enviar("PAYMENT_DELETED", objCobranca(x));
        return json(res, 200, { deleted: true, id: a.id });
      }
    }
    if (metodo === "GET" && p === "/v3/payments") {
      const dados = [...cobrancas.values()]
        .filter((x) => !x.deleted
          && (!query.subscription || x.subscription === query.subscription)
          && (!query.customer || x.customer === query.customer)
          && (!query.status || x.status === query.status))
        .sort((x, y) => porVencimento(y, x));
      return json(res, 200, lista(dados.map(objCobranca), query));
    }
    return erro(res, 404, "not_found", `rota não implementada no dublê: ${metodo} ${p}`);
  }

  async function pagina(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const achado = /^\/i\/([^/]+)(?:\/(pix|cartao))?$/.exec(url.pathname);
    const c = cobrancas.get(achado?.[1] ?? "");
    if (!achado || !c || c.deleted) return paginaHtml(res, 404, "Cobrança não encontrada", "<p>Cobrança desconhecida.</p>");
    const forma = achado[2];
    if (req.method === "POST" && (forma === "pix" || forma === "cartao")) {
      await pagar(c.id, forma);
      res.writeHead(303, { location: `/i/${c.id}` });
      return void res.end();
    }
    const aberta = c.status === "PENDING" || c.status === "OVERDUE";
    return paginaHtml(res, 200, "Fatura de teste do Asaas", `<p>${reais(c.value)} · vence em ${dataBr(c.dueDate)}</p>` + (aberta
      ? `<form method="post" action="/i/${c.id}/pix"><button type="submit">Pagar com Pix de teste</button></form>`
        + `<form method="post" action="/i/${c.id}/cartao"><button type="submit">Pagar com cartão de teste</button></form>`
      : "<p>Pagamento confirmado</p>"));
  }

  /** Aviso feito à mão (forjado ou mentiroso), registrado em `avisos` para a limpeza do e2e achá-lo. */
  async function enviarAvisoManual(token: string, cliente: string): Promise<number> {
    const w = webhooks.at(-1);
    if (!w) throw new Error("sem webhook registrado");
    const id = `evt_${randomBytes(16).toString("hex")}&${proxima()}`;
    const corpo = JSON.stringify({ id, event: "PAYMENT_RECEIVED", dateCreated: "2026-01-01 00:00:00",
      payment: { object: "payment", id: "pay_inventado", customer: cliente, status: "RECEIVED", value: 9999, paymentDate: hojeEmSaoPaulo() } });
    const r = await fetch(w.url, { method: "POST", body: corpo, headers: { "content-type": "application/json", "asaas-access-token": token } });
    avisos.push({ eventoId: id, evento: "PAYMENT_RECEIVED", status: r.status });
    return r.status;
  }

  const controle: DubleAsaas = {
    chamadas,
    avisos,
    urlDoWebhook: () => webhooks.at(-1)?.url ?? null,
    tokenDoWebhook: () => webhooks.at(-1)?.authToken ?? null,
    eventosDoWebhook: () => webhooks.at(-1)?.events ?? [],
    clienteDaOrg: (orgId) => [...clientes.values()].find((x) => x.externalReference === orgId)?.id ?? null,
    cobrancasDe,
    assinaturasDe,
    recusarCriacaoDeWebhook: (recusar) => {
      recusarWebhook = recusar;
    },
    pagar,
    async vencer(cliente) {
      const c = cobrancasDe(cliente).find((x) => x.status === "PENDING");
      if (!c) throw new Error(`cliente ${cliente} sem cobrança pendente no dublê`);
      // O tempo passou só para esta cobrança: venceu ontem e não foi paga.
      c.status = "OVERDUE";
      c.dueDate = somarDias(hojeEmSaoPaulo(), -1);
      await enviar("PAYMENT_OVERDUE", objCobranca(c));
      return urlDaFatura(c);
    },
    enviarAvisoForjado: (cliente) => enviarAvisoManual(randomBytes(32).toString("hex"), cliente),
    enviarAvisoMentiroso: (cliente) => enviarAvisoManual(webhooks.at(-1)?.authToken ?? "", cliente),
  };
  return { api, pagina, controle };
}