/**
 * O ADAPTADOR DA STRIPE da cobrança do revendedor (spec
 * docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §6.1).
 *
 * Sem SDK: `fetch` + `node:crypto` (§1.2). Regras, cada uma com caso em
 * stripe.test.ts:
 * - A chave vai SÓ no header `Authorization`: nunca em query string, log,
 *   mensagem de erro, audit ou Sentry. `ErroDoProvedor` leva o status HTTP e o
 *   `code` da Stripe — nunca o `message`, que ecoa pedaço da chave.
 * - O MODO sai do prefixo da chave (`sk_`/`rk_` + `test`/`live`), que a Stripe
 *   não deixa mentir. Chave real só vai para a base oficial: o stub do e2e roda
 *   em loopback e nunca recebe uma.
 * - Todo POST leva `Idempotency-Key`; a nova tentativa (429, 5xx, rede, 409 de
 *   trava) reusa a MESMA chave, então repetir não cria em dobro. No máximo 3
 *   tentativas e 5 s por espera: webhook, cron e tela têm o próprio retry, e
 *   segurar o clique do usuário por minutos é pior que "provedor indisponível".
 * - Toda resposta passa por Zod lendo só o que é usado; forma inesperada vira
 *   `ErroDoProvedor(200, "resposta_invalida")`, que `sincronizar` grava como
 *   `leitura_invalida` sem tocar o estado.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { logger } from "@/lib/logger";

import {
  ErroDoProvedor,
  type AdaptadorDeCobranca,
  type Modo,
  type PlanoParaProvedor,
  type SinalDoWebhook,
  type Situacao,
  type WebhookPreparado,
} from "./contrato";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * A versão da API fixada. Sem o header, a Stripe responde na versão da CONTA,
 * que o revendedor muda no painel — e `current_period_end` (no item desde a
 * basil) ou `invoice.parent` sumiriam sem erro nenhum.
 *
 * DECISÃO (05/10/2026, docs.stripe.com/changelog lido nesse dia): a última da
 * família dahlia, 2026-08-26.dahlia. A Stripe declara na página da dahlia que
 * as versões depois de 2026-03-25.dahlia "will include only additive changes",
 * então o código escrito contra a 03-25 segue valendo. A GA mais recente é
 * 2026-09-30.endive, uma major, e ficou de fora: das quebras dela, duas caem no
 * escopo da cobrança — unifica o formato de `billing_cycle_anchor` entre
 * Subscription e Invoice, e passa a responder erro "Failed Tax Calculation" em
 * Billing/Checkout. (Remover `payment_method_types` do Checkout não nos pega:
 * nenhum código ou brief o envia.) Subir para a endive é decisão da Task 22, que
 * prova contra a conta de teste: essa prova é scripts/smoke-stripe.ts (fora do
 * CI), que roda na STRIPE_VERSION daqui — trocar a constante e rodá-lo.
 */
export const STRIPE_VERSION = "2026-08-26.dahlia";

/**
 * Marca o que ESTA instalação criou na conta (endpoint e portal), para achar de
 * novo sem guardar id: 16 hex do sha256 da ORIGEM do app. Uma constante igual em
 * toda instalação faria a homologação e a produção de um revendedor, na mesma
 * conta Stripe, apagarem o webhook uma da outra a cada conexão.
 * ponytail: trocar o domínio deixa o endpoint do domínio velho na conta (a Stripe
 * o desativa quando ele falha); um id guardado no banco resolveria, quando pesar.
 */
export function marcaDaInstalacao(urlDoApp: string): string {
  const origem = URL.canParse(urlDoApp) ? new URL(urlDoApp).origin : urlDoApp.trim().toLowerCase();
  return createHash("sha256").update(origem).digest("hex").slice(0, 16);
}

const TENTATIVAS = 3;
const ESPERA_MAXIMA_MS = 5_000;
const TEMPO_LIMITE_MS = 20_000;
const CODIGOS_DE_TRAVA = new Set(["lock_timeout", "idempotency_key_in_use"]);
const PREFIXO_DA_CHAVE = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const HOSTS_DE_LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface DependenciasDaStripe {
  /** A chave em claro, lida A CADA chamada (a tela pode trocá-la). `null` = não configurada. */
  lerChave: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Só a oficial ou loopback (o stub do e2e). Qualquer outra lança na construção. */
  baseUrl?: string;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => Date;
  novaChaveDeIdempotencia?: () => string;
  /** `marcaDaInstalacao(NEXT_PUBLIC_APP_URL)`: o registro (Task 19) injeta. */
  marca: string;
}

/** Nunca `invoice.created`: resposta não-2xx a ele atrasa em até 72 h a finalização da fatura. */
export const EVENTOS_DO_WEBHOOK_STRIPE = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** `teste`/`producao` pelo prefixo; `null` = não é chave secreta nem restrita (inclusive `pk_`). */
export function modoDaChaveStripe(chave: string): Modo | null {
  const m = PREFIXO_DA_CHAVE.exec(chave);
  if (!m) return null;
  return m[1] === "live" ? "producao" : "teste";
}

function baseAceita(base: string): boolean {
  if (base === STRIPE_API_BASE) return true;
  if (!URL.canParse(base)) return false;
  const u = new URL(base);
  return (u.protocol === "http:" || u.protocol === "https:") && HOSTS_DE_LOOPBACK.has(u.hostname);
}

/** Corpo `application/x-www-form-urlencoded` no formato aninhado da Stripe (`a[b][0][c]=v`). */
export function emFormulario(dados: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const por = (chave: string, valor: unknown): void => {
    if (valor === undefined || valor === null) return;
    if (Array.isArray(valor)) {
      valor.forEach((item, i) => por(`${chave}[${i}]`, item));
      return;
    }
    if (typeof valor === "object") {
      for (const [k, v] of Object.entries(valor)) por(`${chave}[${k}]`, v);
      return;
    }
    params.append(chave, String(valor));
  };
  for (const [k, v] of Object.entries(dados)) por(k, v);
  return params.toString();
}

const corpoDeErro = z.object({ error: z.object({ code: z.string().optional(), type: z.string().optional() }) });

/** Status HTTP + `code` da Stripe → `ErroDoProvedor`. Nunca o `message`: ele ecoa pedaço da chave. */
export function erroDaStripe(status: number, corpo: unknown): ErroDoProvedor {
  const lido = corpoDeErro.safeParse(corpo);
  const codigo = lido.success ? lido.data.error.code : undefined;
  const tipo = lido.success ? lido.data.error.type : undefined;
  if (status === 401) return new ErroDoProvedor(401, codigo ?? "chave_invalida", false, true);
  if (status === 403) return new ErroDoProvedor(403, codigo ?? "sem_permissao", false, true);
  if (status === 429) return new ErroDoProvedor(429, codigo ?? "rate_limit", true);
  if (status === 409) return new ErroDoProvedor(409, codigo ?? "conflito", CODIGOS_DE_TRAVA.has(codigo ?? ""));
  if (status >= 500) return new ErroDoProvedor(status, codigo ?? "provedor_fora", true);
  return new ErroDoProvedor(status, codigo ?? tipo ?? "recusado", false);
}

function espera(tentativa: number, retryAfter: string | null): number {
  const pedida = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 500 * 2 ** (tentativa - 1);
  return Math.min(pedida, ESPERA_MAXIMA_MS);
}

function ler<T>(schema: z.ZodType<T>, dados: unknown): T {
  const lido = schema.safeParse(dados);
  if (!lido.success) throw new ErroDoProvedor(200, "resposta_invalida", false);
  return lido.data;
}

const listaQualquer = z.object({ object: z.literal("list") });
const comId = z.object({ id: z.string().min(1) });
const listaDeIds = z.object({ data: z.array(comId) });
const sessaoDeCheckout = z.object({ url: z.string(), expires_at: z.number().int() });
const UUID = z.string().uuid();
/** A Stripe só aceita `trial_end` a 48 h ou mais no futuro. */
const TESTE_MINIMO_MS = 48 * 3600 * 1000;
/**
 * Folga sobre as 48 h: o relógio da VPS pode estar atrás do da Stripe e `chamar`
 * pode levar ~70 s em novas tentativas. Sem ela, quem assina com 48 h + segundos
 * de teste recebe 400 não transitório. Custo: nessa faixa a cobrança é imediata.
 */
const FOLGA_DO_TESTE_MS = 10 * 60 * 1000;

const TERMINAIS = new Set(["canceled", "incomplete_expired"]);
/** Com o 1º pagamento confirmado. `trialing` e `incomplete` ficam fora (§6.1 passo 2). */
const COM_PAGAMENTO = new Set(["active", "past_due", "unpaid", "paused"]);
/** Os três destinos do painel depois das tentativas (§16, 3.3). Boleto aberto de `active` NÃO é atraso. */
const EM_ATRASO = new Set(["past_due", "unpaid", "paused"]);

const assinaturaDaStripe = z.object({
  id: z.string(),
  status: z.string(),
  created: z.number(),
  cancel_at_period_end: z.boolean(),
  cancel_at: z.number().nullish(),
  ended_at: z.number().nullish(),
  trial_end: z.number().nullish(),
  items: z.object({ data: z.array(z.object({ id: z.string(), current_period_end: z.number() })) }),
});
type AssinaturaDaStripe = z.infer<typeof assinaturaDaStripe>;

const faturaDaStripe = z.object({
  id: z.string(),
  created: z.number(),
  amount_paid: z.number(),
  hosted_invoice_url: z.string().nullish(),
  status_transitions: z.object({ paid_at: z.number().nullish() }),
  parent: z.object({ subscription_details: z.object({ subscription: z.string() }).nullish() }).nullish(),
});
type FaturaDaStripe = z.infer<typeof faturaDaStripe>;

const listaDe = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });
const emData = (segundos: number) => new Date(segundos * 1000);

const marcado = z.object({ id: z.string(), url: z.string().optional(), metadata: z.record(z.string(), z.string()).nullish() });
const endpointCriado = z.object({ id: z.string(), secret: z.string().startsWith("whsec_") });

/** Portal SEM troca de plano (§5: troca só pela nossa tela, na virada do ciclo). */
const RECURSOS_DO_PORTAL = {
  payment_method_update: { enabled: true },
  invoice_history: { enabled: true },
  subscription_cancel: { enabled: true, mode: "at_period_end" },
  subscription_update: { enabled: false },
  customer_update: { enabled: false },
};

/** A fatura paga MAIS RECENTE é de uma assinatura já terminal, e foi paga depois do fim dela. */
function pagouAssinaturaEncerrada(pagas: FaturaDaStripe[], assinaturas: AssinaturaDaStripe[]): boolean {
  const ultima = [...pagas].sort((a, b) => (b.status_transitions.paid_at ?? 0) - (a.status_transitions.paid_at ?? 0))[0];
  const pagaEm = ultima?.status_transitions.paid_at ?? null;
  const dona = assinaturas.find((s) => s.id === ultima?.parent?.subscription_details?.subscription);
  const fim = dona?.ended_at ?? null;
  return dona !== undefined && TERMINAIS.has(dona.status) && pagaEm !== null && fim !== null && pagaEm > fim;
}

function precoRecorrente(plano: PlanoParaProvedor, produto: string) {
  return {
    currency: "brl",
    unit_amount: plano.precoCents,
    recurring: { interval: plano.intervalo === "ano" ? "year" : "month" },
    product: produto,
  };
}

/** Janela da assinatura, nos DOIS sentidos: o relógio da VPS pode estar atrás da Stripe. */
export const TOLERANCIA_DO_WEBHOOK_S = 300;

const eventoDaStripe = z.object({
  id: z.string().startsWith("evt_"),
  type: z.string().min(1),
  data: z.object({
    object: z.object({ customer: z.union([z.string(), z.object({ id: z.string() })]).nullish() }),
  }),
});

/**
 * `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` = HMAC-SHA256(segredo,
 * `${t}.${corpoCru}`). Confere CADA `v1` (na rotação do segredo a Stripe assina
 * com o velho e o novo por 24 h); `v0` é ignorado. Devolve só ponteiros
 * (§6: o corpo nunca é fonte de estado) e `null` para tudo que não for evento
 * assinado. Nunca lança: quem chama responde 401 e segue.
 */
export function verificarWebhookStripe(
  corpoCru: string,
  headers: Headers,
  segredo: string,
  agora: Date,
): SinalDoWebhook | null {
  const cabecalho = headers.get("stripe-signature");
  if (!cabecalho || !segredo) return null;
  let t: number | null = null;
  const assinaturas: Buffer[] = [];
  for (const parte of cabecalho.split(",")) {
    const i = parte.indexOf("=");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (nome === "t" && /^\d{1,12}$/.test(valor)) t = Number(valor);
    else if (nome === "v1" && /^[0-9a-f]{64}$/.test(valor)) assinaturas.push(Buffer.from(valor, "hex"));
  }
  if (t === null || assinaturas.length === 0) return null;
  // Falha fechada: com `agora` inválido (NaN) a comparação `>` daria false e pularia a janela.
  if (!(Math.abs(agora.getTime() / 1000 - t) <= TOLERANCIA_DO_WEBHOOK_S)) return null;
  const esperada = createHmac("sha256", segredo).update(`${t}.${corpoCru}`, "utf8").digest();
  // Todas comparadas, sem atalho; o tamanho (32 bytes) já foi garantido pelo regex.
  if (!assinaturas.map((a) => timingSafeEqual(a, esperada)).includes(true)) return null;
  return lerEvento(corpoCru);
}

function lerEvento(corpoCru: string): SinalDoWebhook | null {
  let json: unknown;
  try {
    json = JSON.parse(corpoCru);
  } catch {
    // Assinado e não é JSON: a Stripe não manda isso. Recusar é a leitura segura.
    return null;
  }
  const evento = eventoDaStripe.safeParse(json);
  if (!evento.success) return null;
  const cliente = evento.data.data.object.customer;
  return {
    eventoId: evento.data.id,
    tipo: evento.data.type,
    clienteRef: typeof cliente === "string" ? cliente : (cliente?.id ?? null),
  };
}

export function criarAdaptadorStripe(dep: DependenciasDaStripe): AdaptadorDeCobranca {
  const base = dep.baseUrl ?? STRIPE_API_BASE;
  if (!baseAceita(base)) throw new Error("base da API da Stripe recusada: só a oficial ou loopback");
  const buscar = dep.fetch ?? fetch;
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((pronto) => setTimeout(pronto, ms)));
  const novaChave = dep.novaChaveDeIdempotencia ?? randomUUID;
  const agora = dep.agora ?? (() => new Date());

  async function chaveUsavel(): Promise<string> {
    const chave = await dep.lerChave();
    const modo = chave === null ? null : modoDaChaveStripe(chave);
    if (chave === null || modo === null) throw new ErroDoProvedor(null, "sem_chave", false, true);
    if (modo === "producao" && base !== STRIPE_API_BASE) {
      throw new ErroDoProvedor(null, "chave_real_fora_da_stripe", false, true);
    }
    return chave;
  }

  async function chamar(
    metodo: "GET" | "POST" | "DELETE",
    caminho: string,
    corpo?: Record<string, unknown>,
    chaveDeIdempotencia?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await chaveUsavel()}`,
      "stripe-version": STRIPE_VERSION,
    };
    let body: string | undefined;
    if (metodo === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["idempotency-key"] = chaveDeIdempotencia ?? novaChave();
      body = emFormulario(corpo ?? {});
    }
    for (let tentativa = 1; ; tentativa += 1) {
      let erro: ErroDoProvedor;
      let pedidoDaStripe: string | null = null;
      let retryAfter: string | null = null;
      try {
        const r = await buscar(`${base}${caminho}`, {
          method: metodo,
          headers,
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
        });
        if (r.ok) {
          return await r.json().catch(() => {
            throw new ErroDoProvedor(r.status, "resposta_invalida", false);
          });
        }
        // Corpo de erro que não é JSON (proxy, HTML): fica só o status.
        erro = erroDaStripe(r.status, await r.json().catch(() => null));
        pedidoDaStripe = r.headers.get("stripe-should-retry");
        retryAfter = r.headers.get("retry-after");
      } catch (e) {
        if (e instanceof ErroDoProvedor) throw e;
        erro = new ErroDoProvedor(null, "sem_resposta", true);
      }
      const repetir =
        tentativa < TENTATIVAS && (pedidoDaStripe === "true" || (pedidoDaStripe !== "false" && erro.transitorio));
      if (!repetir) throw erro;
      logger.warn("cobranca.stripe.nova_tentativa", { status: erro.status, codigo: erro.codigo, tentativa });
      await esperar(espera(tentativa, retryAfter));
    }
  }

  async function testarChave(opcoes?: { modoExigido?: Modo }): ReturnType<AdaptadorDeCobranca["testarChave"]> {
    const chave = await dep.lerChave();
    const modo = chave === null ? null : modoDaChaveStripe(chave);
    if (modo === null) return { ok: false, motivo: "chave_invalida" };
    const outroModo = opcoes?.modoExigido !== undefined && opcoes.modoExigido !== modo;
    if (outroModo || (modo === "producao" && base !== STRIPE_API_BASE)) {
      return { ok: false, motivo: "modo_divergente", modo };
    }
    try {
      // `customers` e não `balance`: a chave restrita recomendada (§10) não
      // precisa ler saldo, e o teste mediria uma permissão que a cobrança não usa.
      ler(listaQualquer, await chamar("GET", "/customers?limit=1"));
      return { ok: true, modo };
    } catch (e) {
      if (!(e instanceof ErroDoProvedor)) throw e;
      if (e.status === 401) return { ok: false, motivo: "chave_invalida" };
      if (e.status === 403) return { ok: false, motivo: "sem_permissao" };
      return { ok: false, motivo: "provedor_fora" };
    }
  }

  /**
   * Link do provedor que vira href, redirect ou botão de e-mail: só https (http
   * só com a base de teste em loopback). Defesa em profundidade num caminho de
   * dinheiro: uma resposta adulterada com `javascript:` nunca chega à tela.
   */
  function linkSeguro(u: string | null | undefined): string | null {
    if (!u || !URL.canParse(u)) return null;
    const esquema = new URL(u).protocol;
    if (esquema === "https:" || (esquema === "http:" && base !== STRIPE_API_BASE)) return u;
    logger.warn("cobranca.link_invalido", { esquema });
    return null;
  }

  /** Um produto por PLANO, id previsível: criar de novo é `resource_already_exists`, e o nome é atualizado. */
  async function garantirProduto(plano: PlanoParaProvedor): Promise<string> {
    const id = `dc_plano_${UUID.parse(plano.id)}`;
    try {
      await chamar("POST", "/products", { id, name: plano.nome, metadata: { plano_id: plano.id } });
    } catch (e) {
      if (!(e instanceof ErroDoProvedor) || e.codigo !== "resource_already_exists") throw e;
      await chamar("POST", `/products/${id}`, { name: plano.nome, active: true });
    }
    return id;
  }

  async function garantirCliente(org: Parameters<AdaptadorDeCobranca["garantirCliente"]>[0]): Promise<string> {
    const orgId = UUID.parse(org.id);
    // A busca cura o cliente que já existe na conta (linha local zerada, retomada
    // depois de isentar); a reserva de 2 min do checkout (§7b) segura o clique duplo.
    const consulta = new URLSearchParams({ query: `metadata['organization_id']:'${orgId}'`, limit: "1" });
    const achado = ler(listaDeIds, await chamar("GET", `/customers/search?${consulta}`)).data[0];
    if (achado) return achado.id;
    // Chave de idempotência DA ORG (não aleatória): o índice da busca da Stripe
    // atrasa ~1 min, e um 2º clique depois de uma fase 2 que falhou criaria um
    // cliente duplicado — e `lerSituacao` passaria a ler só um dos dois.
    return ler(
      comId,
      await chamar("POST", "/customers", { email: org.email, name: org.nome, metadata: { organization_id: orgId } }, `cliente:${orgId}`),
    ).id;
  }

  async function iniciarAssinatura(
    p: Parameters<AdaptadorDeCobranca["iniciarAssinatura"]>[0],
  ): ReturnType<AdaptadorDeCobranca["iniciarAssinatura"]> {
    const orgId = UUID.parse(p.orgId);
    const produto = await garantirProduto(p.plano);
    const trialEnd =
      p.trialAte !== null && p.trialAte.getTime() - agora().getTime() >= TESTE_MINIMO_MS + FOLGA_DO_TESTE_MS
        ? Math.floor(p.trialAte.getTime() / 1000)
        : undefined;
    const sucesso = new URL(p.urlDeVolta);
    sucesso.searchParams.set("voltou", "1");
    const metadados = { organization_id: orgId, plano_id: p.plano.id };
    const sessao = ler(
      sessaoDeCheckout,
      await chamar(
        "POST",
        "/checkout/sessions",
        {
          mode: "subscription",
          customer: p.clienteRef,
          client_reference_id: orgId,
          line_items: [{ price_data: precoRecorrente(p.plano, produto), quantity: 1 }],
          subscription_data: { metadata: metadados, trial_end: trialEnd },
          metadata: metadados,
          success_url: sucesso.toString(),
          cancel_url: p.urlDeVolta,
          locale: "pt-BR",
        },
        `${p.chaveIdempotencia}:checkout`,
      ),
    );
    const url = linkSeguro(sessao.url);
    if (url === null) throw new ErroDoProvedor(200, "resposta_invalida", false);
    // A assinatura só nasce depois do pagamento (Checkout desde a basil): sem ref aqui.
    return { url, expiraEm: new Date(sessao.expires_at * 1000), assinaturaRef: null };
  }

  // ponytail: 10 assinaturas e 10 faturas por cliente, sem paginar. Um cliente
  // de revendedor tem 1 ou 2; paginar quando `has_more` aparecer medido.
  async function lerSituacao(p: { clienteRef: string }): Promise<Situacao> {
    const cliente = encodeURIComponent(p.clienteRef);
    const [assinaturas, pagas] = await Promise.all([
      chamar("GET", `/subscriptions?customer=${cliente}&status=all&limit=10`).then((d) => ler(listaDe(assinaturaDaStripe), d).data),
      chamar("GET", `/invoices?customer=${cliente}&status=paid&limit=10`).then((d) =>
        ler(listaDe(faturaDaStripe), d).data.filter((f) => f.amount_paid > 0),
      ),
    ]);
    const recentes = [...assinaturas].sort((a, b) => b.created - a.created);
    const vivas = recentes.filter((s) => !TERMINAIS.has(s.status));
    const principal = vivas[0] ?? null;
    const referencia = principal ?? recentes[0] ?? null;
    const faturasDaPrincipal = async (status: "open" | "uncollectible") =>
      principal
        ? ler(
            listaDe(faturaDaStripe),
            await chamar("GET", `/invoices?subscription=${encodeURIComponent(principal.id)}&status=${status}&limit=10`),
          ).data.sort((a, b) => a.created - b.created)
        : [];
    const emAtraso = principal !== null && EM_ATRASO.has(principal.status);
    let link = linkSeguro((await faturasDaPrincipal("open"))[0]?.hosted_invoice_url);
    // Depois das tentativas, o painel da Stripe pode marcar a fatura como
    // incobrável ("Manage failed payments"): ela sai de `open`, mas a página
    // hospedada ainda recebe o pagamento. Sem isto, quem deve e quer pagar não
    // tem por onde (o "Assinar" some com assinatura viva).
    if (link === null && emAtraso) link = linkSeguro((await faturasDaPrincipal("uncollectible"))[0]?.hosted_invoice_url);
    const existe = principal !== null && COM_PAGAMENTO.has(principal.status);
    const fimDoTeste = principal?.status === "trialing" ? (principal.trial_end ?? null) : null;
    const fimDoItem = principal?.items.data[0]?.current_period_end ?? null;
    const cancelaNoFim = principal !== null && (principal.cancel_at_period_end || (principal.cancel_at ?? null) !== null);
    const fimDoPeriodo = existe ? fimDoItem : fimDoTeste;
    return {
      assinaturaRef: referencia?.id ?? null,
      existe,
      assinaturasVivas: vivas.length,
      cancelada: recentes.length > 0 && principal === null,
      cancelaNoFim,
      emAtraso,
      vencidaDesde: null,
      proximoVencimento: fimDoPeriodo === null ? null : emData(fimDoPeriodo),
      jaPagou: pagas.length > 0,
      emTesteNoProvedorAte: fimDoTeste === null ? null : emData(fimDoTeste),
      pagamentoSemAssinaturaViva: pagouAssinaturaEncerrada(pagas, recentes),
      linkDePagamento: link,
      statusBruto: principal
        ? `${principal.status}${cancelaNoFim ? ":cancela_no_fim" : ""}`
        : referencia
          ? `${referencia.status}:encerrada`
          : "sem_assinatura",
    };
  }

  async function trocarPlano(p: { assinaturaRef: string; plano: PlanoParaProvedor }): Promise<void> {
    const caminho = `/subscriptions/${encodeURIComponent(p.assinaturaRef)}`;
    const item = ler(assinaturaDaStripe, await chamar("GET", caminho)).items.data[0];
    if (!item) throw new ErroDoProvedor(null, "assinatura_sem_item", false);
    const produto = await garantirProduto(p.plano);
    // Sem proração: o período em curso segue no preço pago; a próxima fatura sai com o novo (D-3).
    await chamar("POST", caminho, {
      items: [{ id: item.id, price_data: precoRecorrente(p.plano, produto) }],
      proration_behavior: "none",
      metadata: { plano_id: p.plano.id },
    });
  }

  async function cancelarNoFim(assinaturaRef: string): Promise<void> {
    await chamar("POST", `/subscriptions/${encodeURIComponent(assinaturaRef)}`, { cancel_at_period_end: true });
  }

  const metadadosDaMarca = { cobranca_do_revendedor: dep.marca };
  const ehNosso = (m: Record<string, string> | null | undefined) => m?.cobranca_do_revendedor === dep.marca;

  async function clienteExiste(clienteRef: string): Promise<boolean> {
    try {
      ler(comId, await chamar("GET", `/customers/${encodeURIComponent(clienteRef)}`));
      return true;
    } catch (e) {
      if (e instanceof ErroDoProvedor && e.status === 404) return false;
      throw e;
    }
  }

  /** Apaga os endpoints DESTA instalação (mesma URL ou mesma marca), menos `exceto`. */
  async function removerWebhooks(url: string, exceto?: string): Promise<number> {
    const nossos = ler(listaDe(marcado), await chamar("GET", "/webhook_endpoints?limit=100")).data.filter(
      (e) => e.id !== exceto && (e.url === url || ehNosso(e.metadata)),
    );
    for (const e of nossos) await apagarEndpoint(e.id);
    return nossos.length;
  }

  /** 404 é o efeito desejado (alguém apagou antes, ou é a 2ª tentativa): não é falha. */
  async function apagarEndpoint(id: string): Promise<void> {
    try {
      await chamar("DELETE", `/webhook_endpoints/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof ErroDoProvedor && e.status === 404)) throw e;
    }
  }

  /**
   * A configuração de portal desta instalação, achada pela marca (sem id guardado).
   * `reaplicar` (na conexão) regrava os recursos; o clique do cliente só cria se faltar.
   */
  async function portal(reaplicar: boolean): Promise<string> {
    const existentes = ler(listaDe(marcado), await chamar("GET", "/billing_portal/configurations?active=true&limit=100")).data;
    const nosso = existentes.find((c) => ehNosso(c.metadata));
    if (nosso && !reaplicar) return nosso.id;
    const caminho = nosso ? `/billing_portal/configurations/${encodeURIComponent(nosso.id)}` : "/billing_portal/configurations";
    return ler(comId, await chamar("POST", caminho, { features: RECURSOS_DO_PORTAL, metadata: metadadosDaMarca })).id;
  }

  /**
   * Cria o endpoint novo e NÃO apaga nada: quem chama grava o segredo e só
   * então `confirmar()` apaga os antigos. Se a gravação falhar, `desfazer()`
   * apaga o novo e o antigo, com o segredo que está no banco, segue valendo —
   * a ordem inversa deixaria todo aviso em 401 até o dono reconectar.
   * O segredo só vem na criação; por isso não se "atualiza" um endpoint existente.
   */
  async function prepararWebhook(url: string): Promise<WebhookPreparado> {
    // O portal vem ANTES: se ele falhar (chave restrita sem billing_portal, 4xx, 5xx), nada foi criado
    // e não sobra endpoint órfão cujo segredo nunca foi gravado.
    await portal(true);
    const criado = ler(
      endpointCriado,
      await chamar("POST", "/webhook_endpoints", {
        url,
        enabled_events: [...EVENTOS_DO_WEBHOOK_STRIPE],
        api_version: STRIPE_VERSION,
        description: "Cobrança do revendedor",
        metadata: metadadosDaMarca,
      }),
    );
    return {
      segredo: criado.secret,
      confirmar: async () => {
        await removerWebhooks(url, criado.id);
      },
      desfazer: async () => {
        await apagarEndpoint(criado.id);
      },
    };
  }

  async function urlDeGerenciar(p: { clienteRef: string; urlDeVolta: string }): Promise<string> {
    const configuracao = await portal(false);
    const sessao = ler(
      z.object({ url: z.string() }),
      await chamar("POST", "/billing_portal/sessions", { customer: p.clienteRef, return_url: p.urlDeVolta, configuration: configuracao }),
    );
    const url = linkSeguro(sessao.url);
    if (url === null) throw new ErroDoProvedor(200, "resposta_invalida", false);
    return url;
  }

  return {
    id: "stripe",
    testarChave,
    verificarWebhook: verificarWebhookStripe,
    garantirCliente,
    iniciarAssinatura,
    lerSituacao,
    trocarPlano,
    cancelarNoFim,
    prepararWebhook,
    removerWebhooks,
    clienteExiste,
    urlDeGerenciar,
  };
}
