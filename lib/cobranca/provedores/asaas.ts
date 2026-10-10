/**
 * O ADAPTADOR DO ASAAS da cobrança do revendedor (spec
 * docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §6.2).
 *
 * Por que o Asaas existe ao lado da Stripe: Pix e boleto RECORRENTES para o
 * cliente brasileiro, que a Stripe BR não faz. Sem SDK: `fetch` + `node:crypto`
 * (§1.2). Regras, cada uma com caso em asaas.test.ts:
 * - A chave vai SÓ no header `access_token`: nunca em query string, log,
 *   mensagem de erro, audit ou Sentry. `ErroDoProvedor` leva o status HTTP e o
 *   `code` do Asaas, nunca a `description`, que ecoa dado do pagador.
 * - O MODO e a BASE saem do prefixo da chave (`$aact_prod_` produção,
 *   `$aact_hmlg_` sandbox): a chave de um ambiente nunca é enviada ao outro, e
 *   a de produção nunca vai ao dublê em loopback do e2e.
 * - O Asaas não aceita chave de idempotência. GET, PUT e DELETE repetem em 429,
 *   5xx e rede; POST repete SÓ em 429 (recusado antes de processar). A
 *   idempotência do POST é a RELEITURA antes de criar: cliente pela
 *   `externalReference`, assinatura ACTIVE, webhook pela URL ou pelo nome.
 *   No máximo 3 tentativas e 5 s por espera.
 * - Toda resposta passa por Zod lendo só o que é usado; forma inesperada vira
 *   `ErroDoProvedor(200, "resposta_invalida")`, que `sincronizar` grava como
 *   `leitura_invalida` sem tocar o estado.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { documentoDoPagador } from "@/lib/cobranca/documento";
import { FUSO_PADRAO } from "@/lib/cobranca/fuso";
import { logger } from "@/lib/logger";

import { ErroDoProvedor, type AdaptadorDeCobranca, type Modo, type SinalDoWebhook, type Situacao, type WebhookPreparado } from "./contrato";

/** A base de cada ambiente. Qual vale sai do prefixo da chave. */
export const ASAAS_API_BASE = {
  producao: "https://api.asaas.com/v3",
  teste: "https://api-sandbox.asaas.com/v3",
} as const satisfies Record<Modo, string>;

const TENTATIVAS = 3;
const ESPERA_MAXIMA_MS = 5_000;
const TEMPO_LIMITE_MS = 20_000;
const PREFIXO_DA_CHAVE = /^\$aact_(prod|hmlg)_\S{16,}$/;
/** O `code` do Asaas só sai do adaptador se for um identificador: nada de texto livre. */
const CODIGO_SEGURO = /^[A-Za-z0-9_.:-]{1,80}$/;
const HOSTS_DE_LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface DependenciasDoAsaas {
  /** A chave em claro, lida A CADA chamada (a tela pode trocá-la). `null` = não configurada. */
  lerChave: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Só loopback (o dublê do e2e), e então só chave de sandbox. Outra base lança na construção. */
  baseUrl?: string;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => Date;
  /** `marcaDaInstalacao(NEXT_PUBLIC_APP_URL)`: nomeia o webhook DESTA instalação e vai no User-Agent. */
  marca: string;
}

/** `teste`/`producao` pelo prefixo; `null` = não é chave do Asaas com ambiente declarado. */
export function modoDaChaveAsaas(chave: string): Modo | null {
  const m = PREFIXO_DA_CHAVE.exec(chave);
  if (!m) return null;
  return m[1] === "prod" ? "producao" : "teste";
}

function baseDeLoopback(base: string): boolean {
  if (!URL.canParse(base)) return false;
  const u = new URL(base);
  return (u.protocol === "http:" || u.protocol === "https:") && HOSTS_DE_LOOPBACK.has(u.hostname);
}

const corpoDeErro = z.object({ errors: z.array(z.object({ code: z.string().optional() })) });

/** Status HTTP + `code` do Asaas → `ErroDoProvedor`. Nunca a `description`. */
export function erroDoAsaas(status: number, corpo: unknown): ErroDoProvedor {
  const lido = corpoDeErro.safeParse(corpo);
  const bruto = lido.success ? lido.data.errors[0]?.code : undefined;
  const codigo = bruto !== undefined && CODIGO_SEGURO.test(bruto) ? bruto : undefined;
  if (status === 401) return new ErroDoProvedor(401, "chave_invalida", false, true);
  if (status === 403) return new ErroDoProvedor(403, codigo ?? "sem_permissao", false, true);
  if (status === 429) return new ErroDoProvedor(429, "rate_limit", true);
  if (status >= 500) return new ErroDoProvedor(status, "provedor_fora", true);
  return new ErroDoProvedor(status, codigo ?? (status === 404 ? "nao_encontrado" : "recusado"), false);
}

function espera(tentativa: number, pedida: string | null): number {
  const ms = pedida !== null && /^\d+$/.test(pedida) ? Number(pedida) * 1000 : 500 * 2 ** (tentativa - 1);
  return Math.min(ms, ESPERA_MAXIMA_MS);
}

function ler<T>(schema: z.ZodType<T>, dados: unknown): T {
  const lido = schema.safeParse(dados);
  if (!lido.success) throw new ErroDoProvedor(200, "resposta_invalida", false);
  return lido.data;
}

const comId = z.object({ id: z.string().min(1), deleted: z.boolean().nullish() });
const UUID = z.string().uuid();
const cobrancaDoAsaas = z.object({
  id: z.string().min(1),
  status: z.string(),
  dueDate: z.string(),
  subscription: z.string().nullish(),
  invoiceUrl: z.string().nullish(),
});
type CobrancaDoAsaas = z.infer<typeof cobrancaDoAsaas>;
/** Data civil `AAAA-MM-DD` ordena como texto. */
const porVencimento = (a: CobrancaDoAsaas, b: CobrancaDoAsaas) => a.dueDate.localeCompare(b.dueDate);
const CICLO_DO_INTERVALO = { mes: "MONTHLY", ano: "YEARLY" } as const;
const assinaturaDoAsaas = z.object({
  id: z.string().min(1),
  status: z.string(),
  deleted: z.boolean().nullish(),
  cycle: z.string(),
  dateCreated: z.string(),
});
type AssinaturaDoAsaas = z.infer<typeof assinaturaDoAsaas>;
/** Removida (`deleted`), INACTIVE ou EXPIRED. */
const ehTerminal = (s: AssinaturaDoAsaas) => s.deleted === true || s.status === "INACTIVE" || s.status === "EXPIRED";
/** O mesmo conjunto de "pago" em `existe`, `jaPagou` e `proximoVencimento`. CONFIRMED = cartão aprovado. */
const STATUS_PAGOS = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"] as const;
const PAGO = new Set<string>(STATUS_PAGOS);
/** Estorno ou contestação do período corrente reabre a dívida. */
const ESTORNADO = new Set(["REFUNDED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE"]);

/** A org vem da sessão; mesmo assim, um id que não é uuid vira ErroDoProvedor, nunca ZodError. */
function uuidDaOrg(id: string): string {
  const lido = UUID.safeParse(id);
  if (!lido.success) throw new ErroDoProvedor(null, "org_invalida", false);
  return lido.data;
}
const listaDoAsaas = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

const DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;
const PARTES_EM_SP = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO_PADRAO,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const DIAS_DO_CICLO: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14 };
const MESES_DO_CICLO: Record<string, number> = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUALLY: 6, YEARLY: 12 };

function partesEmSaoPaulo(instante: number) {
  const partes = PARTES_EM_SP.formatToParts(new Date(instante));
  const v = (tipo: Intl.DateTimeFormatPartTypes) => Number(partes.find((p) => p.type === tipo)?.value);
  return { ano: v("year"), mes: v("month"), dia: v("day"), hora: v("hour"), minuto: v("minute"), segundo: v("second") };
}

function lerDataCivil(data: string): [number, number, number] {
  const m = DATA_CIVIL.exec(data);
  const [a, mes, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number.NaN, Number.NaN, Number.NaN];
  const conferida = new Date(Date.UTC(a, mes - 1, d));
  if (!m || conferida.getUTCFullYear() !== a || conferida.getUTCMonth() !== mes - 1 || conferida.getUTCDate() !== d) {
    throw new ErroDoProvedor(200, "resposta_invalida", false);
  }
  return [a, mes, d];
}

/** O dia civil em São Paulo de um instante (`AAAA-MM-DD`). */
export function dataCivilEmSaoPaulo(instante: Date): string {
  const p = partesEmSaoPaulo(instante.getTime());
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/**
 * `dueDate` do Asaas é data civil e o cliente paga até o fim do dia: vale até
 * 23:59:59 em São Paulo. O deslocamento vem da tabela de fusos (duas voltas: a
 * 2ª corrige o chute que caiu do outro lado de uma virada de horário), nunca
 * de um "-3" fixo — o horário de verão já existiu e pode voltar.
 */
export function fimDoDiaEmSaoPaulo(data: string): Date {
  const [a, m, d] = lerDataCivil(data);
  const relogio = Date.UTC(a, m - 1, d, 23, 59, 59);
  let instante = relogio + 3 * 3_600_000;
  for (let volta = 0; volta < 2; volta += 1) {
    const p = partesEmSaoPaulo(instante);
    instante = relogio - (Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - instante);
  }
  return new Date(instante);
}

/** Data civil + um `cycle` do Asaas. Dia 31 num mês menor cai no último dia dele. */
export function somarCiclo(data: string, ciclo: string): string {
  const [a, m, d] = lerDataCivil(data);
  const dias = DIAS_DO_CICLO[ciclo];
  if (dias !== undefined) return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
  const meses = MESES_DO_CICLO[ciclo];
  if (meses === undefined) throw new ErroDoProvedor(200, "resposta_invalida", false);
  const ultimoDia = new Date(Date.UTC(a, m - 1 + meses + 1, 0)).getUTCDate();
  return new Date(Date.UTC(a, m - 1 + meses, Math.min(d, ultimoDia))).toISOString().slice(0, 10);
}

/** Os 11 avisos que acordam a releitura (§6.2). Nenhum carrega estado: é só o "releia". */
export const EVENTOS_DO_WEBHOOK_ASAAS = [
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
] as const;

const webhookDoAsaas = z.object({ id: z.string().min(1), url: z.string().nullish(), name: z.string().nullish() });

const eventoDoAsaas = z.object({
  // Tetos de tamanho: com o token vazado, cada aviso válido vira uma linha no arquivo de avisos.
  id: z.string().min(1).max(100),
  event: z.string().regex(/^[A-Z_]{1,64}$/),
  payment: z.object({ customer: z.string().nullish() }).nullish(),
  subscription: z.object({ customer: z.string().nullish() }).nullish(),
});

/**
 * O Asaas autentica o aviso com o `authToken` que NÓS geramos, ecoado em
 * `asaas-access-token`: sem HMAC nem horário, então o corpo só serve de
 * ponteiro (§6.2; risco 5 da §15) e toda decisão vem da releitura. Compara o
 * sha256 dos dois lados com `timingSafeEqual`: tamanho sempre igual, sem
 * atalho que vaze tamanho ou prefixo do token. Nunca lança. `_agora` existe só
 * para a forma do contrato (o Asaas não manda horário): sem ele, o objeto do
 * adaptador teria `verificarWebhook` de 3 parâmetros até a Task 10 o anotar, e o
 * teste que chama com 4 não compilaria (TS2554).
 */
export function verificarWebhookAsaas(corpoCru: string, headers: Headers, segredo: string, _agora?: Date): SinalDoWebhook | null {
  const recebido = headers.get("asaas-access-token");
  if (!recebido || !segredo) return null;
  const esperado = createHash("sha256").update(segredo, "utf8").digest();
  if (!timingSafeEqual(createHash("sha256").update(recebido, "utf8").digest(), esperado)) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(corpoCru);
  } catch {
    // segue para o ponteiro de forma desconhecida
  }
  const evento = eventoDoAsaas.safeParse(json);
  if (evento.success) {
    const { id, event, payment, subscription } = evento.data;
    return { eventoId: id, tipo: event, clienteRef: payment?.customer ?? subscription?.customer ?? null };
  }
  // Token CERTO e forma inesperada: é o Asaas, não um atacante. Recusar (401) faria
  // o Asaas pausar a FILA de avisos depois das falhas seguidas, e um aviso esquisito
  // travaria todos os seguintes. Como o corpo é só ponteiro, vira um ponteiro SEM
  // empresa (a Visão geral o conta como "aviso sem empresa"), com id estável pelo
  // conteúdo — a nova tentativa do Asaas cai no mesmo 23505 — e tamanho limitado.
  const bruto = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const tipo = typeof bruto.event === "string" && /^[A-Z_]{1,64}$/.test(bruto.event) ? bruto.event : "DESCONHECIDO";
  const resumo = createHash("sha256").update(corpoCru, "utf8").digest("hex").slice(0, 40);
  return { eventoId: `forma:${resumo}`, tipo, clienteRef: null };
}

export function criarAdaptadorAsaas(dep: DependenciasDoAsaas): AdaptadorDeCobranca {
  if (dep.baseUrl !== undefined && !baseDeLoopback(dep.baseUrl)) {
    throw new Error("base da API do Asaas recusada: só a oficial ou loopback");
  }
  const buscar = dep.fetch ?? fetch;
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((pronto) => setTimeout(pronto, ms)));
  const userAgent = `cobranca-do-revendedor/${dep.marca}`;
  const agora = dep.agora ?? (() => new Date());

  /**
   * Link do provedor que vira href, redirect ou botão de e-mail: só https (http
   * só com o dublê em loopback). Uma resposta adulterada com `javascript:` nunca chega à tela.
   */
  function linkSeguro(u: string | null | undefined): string | null {
    if (!u || !URL.canParse(u)) return null;
    const esquema = new URL(u).protocol;
    if (esquema === "https:" || (esquema === "http:" && dep.baseUrl !== undefined)) return u;
    logger.warn("cobranca.link_invalido", { esquema });
    return null;
  }

  // ponytail: 100 cobranças por assinatura, sem paginar (8 anos de mensal); paginar quando `hasMore` aparecer medido.
  async function cobrancasDaAssinatura(assinaturaRef: string): Promise<CobrancaDoAsaas[]> {
    const caminho = `/payments?subscription=${encodeURIComponent(assinaturaRef)}&limit=100`;
    return [...ler(listaDoAsaas(cobrancaDoAsaas), await chamar("GET", caminho)).data].sort(porVencimento);
  }

  async function credencial(): Promise<{ chave: string; base: string }> {
    const chave = await dep.lerChave();
    const modo = chave === null ? null : modoDaChaveAsaas(chave);
    if (chave === null || modo === null) throw new ErroDoProvedor(null, "sem_chave", false, true);
    if (dep.baseUrl === undefined) return { chave, base: ASAAS_API_BASE[modo] };
    if (modo === "producao") throw new ErroDoProvedor(null, "chave_real_fora_do_asaas", false, true);
    return { chave, base: dep.baseUrl.replace(/\/+$/, "") };
  }

  async function chamar(
    metodo: "GET" | "POST" | "PUT" | "DELETE",
    caminho: string,
    corpo?: Record<string, unknown>,
  ): Promise<unknown> {
    const { chave, base } = await credencial();
    const headers: Record<string, string> = { access_token: chave, "user-agent": userAgent, accept: "application/json" };
    const body = corpo === undefined ? undefined : JSON.stringify(corpo);
    if (body !== undefined) headers["content-type"] = "application/json";
    for (let tentativa = 1; ; tentativa += 1) {
      let erro: ErroDoProvedor;
      let pedida: string | null = null;
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
        erro = erroDoAsaas(r.status, await r.json().catch(() => null));
        pedida = r.headers.get("retry-after") ?? r.headers.get("ratelimit-reset");
      } catch (e) {
        if (e instanceof ErroDoProvedor) throw e;
        erro = new ErroDoProvedor(null, "sem_resposta", true);
      }
      // Sem chave de idempotência, um POST que caiu na rede ou levou 5xx pode ter
      // sido processado: repetir criaria em dobro. 429 é recusa antes de processar.
      const repetivel = metodo === "POST" ? erro.status === 429 : erro.transitorio;
      if (!(tentativa < TENTATIVAS && repetivel)) throw erro;
      logger.warn("cobranca.asaas.nova_tentativa", { status: erro.status, codigo: erro.codigo, tentativa });
      await esperar(espera(tentativa, pedida));
    }
  }

  /** O cliente existe na conta DESTA chave? 404 ou removido → false; o resto sobe. */
  async function clienteExiste(clienteRef: string): Promise<boolean> {
    try {
      return ler(comId, await chamar("GET", `/customers/${encodeURIComponent(clienteRef)}`)).deleted !== true;
    } catch (e) {
      if (e instanceof ErroDoProvedor && e.status === 404) return false;
      throw e;
    }
  }

  /**
   * O modo é o do prefixo; a chamada confirma que a chave autentica NA base
   * daquele ambiente. `modoExigido` e o dublê em loopback recusam o modo
   * trocado ANTES de enviar: chave real nunca sai só para confirmar que é real.
   */
  async function testarChave(opcoes?: { modoExigido?: Modo }): ReturnType<AdaptadorDeCobranca["testarChave"]> {
    const chave = await dep.lerChave();
    const modo = chave === null ? null : modoDaChaveAsaas(chave);
    if (modo === null) return { ok: false, motivo: "chave_invalida" };
    const outroModo = opcoes?.modoExigido !== undefined && opcoes.modoExigido !== modo;
    if (outroModo || (modo === "producao" && dep.baseUrl !== undefined)) return { ok: false, motivo: "modo_divergente", modo };
    try {
      ler(listaDoAsaas(z.unknown()), await chamar("GET", "/customers?limit=1"));
      return { ok: true, modo };
    } catch (e) {
      if (!(e instanceof ErroDoProvedor)) throw e;
      if (e.status === 401) return { ok: false, motivo: "chave_invalida" };
      if (e.status === 403) return { ok: false, motivo: "sem_permissao" };
      return { ok: false, motivo: "provedor_fora" };
    }
  }

  /** O webhook do Asaas não tem metadados: a marca DESTA instalação vai no nome. */
  const nomeDoWebhook = `Cobrança do revendedor ${dep.marca}`;

  /** 404 é o efeito desejado (alguém apagou antes, ou é a 2ª tentativa): não é falha. */
  async function apagarWebhook(id: string): Promise<void> {
    try {
      await chamar("DELETE", `/webhooks/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof ErroDoProvedor && e.status === 404)) throw e;
    }
  }

  /** A URL sem a query de conexão: é o que identifica o aviso desta instalação. */
  const baseDaUrl = (url: string) => url.split("?")[0] ?? url;

  /**
   * Apaga os webhooks DESTA instalação (mesma URL, com ou sem a query de conexão,
   * ou mesmo nome), menos `exceto`. Devolve quantos.
   */
  async function removerWebhooks(url: string, exceto?: string): Promise<number> {
    const base = baseDaUrl(url);
    const nossos = ler(listaDoAsaas(webhookDoAsaas), await chamar("GET", "/webhooks?limit=100")).data.filter(
      (w) => w.id !== exceto && (baseDaUrl(w.url ?? "") === base || w.name === nomeDoWebhook),
    );
    for (const w of nossos) await apagarWebhook(w.id);
    return nossos.length;
  }

  /**
   * O token (32 bytes aleatórios) é NOSSO; o Asaas o ecoa em cada aviso. Cria o
   * novo e não apaga nada: `confirmar()` apaga os antigos depois que quem chama
   * gravou o token, `desfazer()` apaga o novo se a gravação falhar (molde da
   * Stripe). Recusa definitiva (4xx que não é 401: conta sem webhook por API,
   * limite de webhooks, e-mail recusado) vira o ramo `manual`: a tela mostra
   * URL, token e eventos para o dono cadastrar no painel, com o MESMO token.
   * Rede, 5xx e 401 sobem: são "tente de novo" e "chave errada".
   *
   * O Asaas recusa (400 invalid_object) um 2º aviso com a MESMA URL, o que
   * quebraria toda reconexão. Medido no sandbox: a mesma URL com `?conexao=<8 hex>`
   * é aceita como distinta e os dois coexistem. A rota de aviso ignora a query.
   * Assim a troca segue em duas fases, sem janela em que o token do Asaas e o do
   * banco divirjam.
   */
  async function prepararWebhook(
    url: string,
    emailDoDono: string,
  ): Promise<WebhookPreparado | { manual: { url: string; segredo: string; eventos: string[] } }> {
    const segredo = randomBytes(32).toString("base64url");
    url = `${baseDaUrl(url)}?conexao=${randomBytes(4).toString("hex")}`;
    let criado: string;
    try {
      criado = ler(
        comId,
        await chamar("POST", "/webhooks", {
          name: nomeDoWebhook,
          url,
          email: emailDoDono,
          enabled: true,
          interrupted: false,
          apiVersion: 3,
          sendType: "SEQUENTIALLY",
          authToken: segredo,
          events: [...EVENTOS_DO_WEBHOOK_ASAAS],
        }),
      ).id;
    } catch (e) {
      const definitiva = e instanceof ErroDoProvedor && !e.transitorio && e.status !== null && e.status >= 400 && e.status !== 401;
      if (!definitiva) throw e;
      logger.warn("cobranca.asaas.webhook_manual", { status: e.status, codigo: e.codigo });
      return { manual: { url, segredo, eventos: [...EVENTOS_DO_WEBHOOK_ASAAS] } };
    }
    return {
      segredo,
      confirmar: async () => {
        await removerWebhooks(url, criado);
      },
      desfazer: async () => {
        await apagarWebhook(criado);
      },
    };
  }

  /**
   * Busca pela `externalReference` (= org) antes de criar: o POST não tem chave
   * de idempotência, e é a busca que cura o clique repetido e a resposta
   * perdida. O documento vai só no corpo do POST. `notificationDisabled`: quem
   * avisa o pagador é a régua do sistema, com a marca da empresa; os e-mails,
   * SMS e WhatsApp do Asaas sairiam em dobro, com a marca dele, e alguns são cobrados.
   */
  async function garantirCliente(org: Parameters<AdaptadorDeCobranca["garantirCliente"]>[0]): Promise<string> {
    const orgId = uuidDaOrg(org.id);
    if (org.documento === null) throw new ErroDoProvedor(null, "documento_obrigatorio", false);
    const documento = documentoDoPagador(org.documento);
    if (documento === null) throw new ErroDoProvedor(null, "documento_invalido", false);
    const consulta = new URLSearchParams({ externalReference: orgId, limit: "10" });
    const achado = ler(listaDoAsaas(comId), await chamar("GET", `/customers?${consulta}`)).data.find((c) => c.deleted !== true);
    if (achado) return achado.id;
    return ler(
      comId,
      await chamar("POST", "/customers", {
        name: org.nome,
        email: org.email,
        cpfCnpj: documento,
        externalReference: orgId,
        notificationDisabled: true,
      }),
    ).id;
  }

  /**
   * Releitura antes de criar (sem chave de idempotência): uma assinatura ACTIVE
   * do cliente é a de um POST anterior que processou e perdeu a resposta.
   * `urlDeVolta` e `chaveIdempotencia` não se aplicam: a fatura do Asaas não
   * expira nem devolve o cliente — a volta é o "Já paguei", que relê.
   */
  async function iniciarAssinatura(
    p: Parameters<AdaptadorDeCobranca["iniciarAssinatura"]>[0],
  ): ReturnType<AdaptadorDeCobranca["iniciarAssinatura"]> {
    const orgId = uuidDaOrg(p.orgId);
    const caminho = `/subscriptions?customer=${encodeURIComponent(p.clienteRef)}&status=ACTIVE&limit=10`;
    const ativas = ler(listaDoAsaas(comId), await chamar("GET", caminho)).data.filter((s) => s.deleted !== true);
    const hoje = dataCivilEmSaoPaulo(agora());
    const fimDoTeste = p.trialAte === null ? null : dataCivilEmSaoPaulo(p.trialAte);
    const assinaturaRef =
      ativas[0]?.id ??
      ler(
        comId,
        await chamar("POST", "/subscriptions", {
          customer: p.clienteRef,
          // UNDEFINED: o cliente escolhe Pix, boleto ou cartão na fatura — é o motivo de o Asaas existir aqui.
          billingType: "UNDEFINED",
          value: p.plano.precoCents / 100,
          cycle: CICLO_DO_INTERVALO[p.plano.intervalo],
          nextDueDate: fimDoTeste !== null && fimDoTeste > hoje ? fimDoTeste : hoje,
          description: p.plano.nome,
          externalReference: orgId,
        }),
      ).id;
    const primeira = (await cobrancasDaAssinatura(assinaturaRef)).find((c) => c.status === "PENDING" || c.status === "OVERDUE");
    if (primeira === undefined) throw new ErroDoProvedor(null, "cobranca_ainda_nao_gerada", true);
    const url = linkSeguro(primeira.invoiceUrl);
    if (url === null) throw new ErroDoProvedor(200, "resposta_invalida", false);
    return { url, expiraEm: null, assinaturaRef };
  }

  /**
   * §6.2 passo a passo: (1) assinaturas COM as removidas; (2) `existe` só com
   * cobrança paga da principal — ACTIVE só com PENDING é o "incomplete" do
   * Asaas; (3) atraso = OVERDUE da principal ou estorno/contestação do período
   * corrente; (4) CONFIRMED é pago; (5) fim do período = maior vencimento PAGO
   * + um ciclo, nunca `nextDueDate` (a cobrança gerada 40 dias antes não é
   * período pago); (6) `jaPagou` pelos mesmos status; (7) link da vencida mais
   * antiga, senão da pendente, só da principal viva; (8)
   * `pagamentoSemAssinaturaViva` é sempre false no Asaas: a API não diz quando
   * a assinatura foi removida, e o DELETE leva junto as cobranças abertas.
   */
  async function lerSituacao(p: { clienteRef: string }): Promise<Situacao> {
    const cliente = encodeURIComponent(p.clienteRef);
    const [assinaturas, pagas] = await Promise.all([
      // includeDeleted: sem ele a removida some, e o cancelamento viraria "teste vencido".
      chamar("GET", `/subscriptions?customer=${cliente}&includeDeleted=true&limit=100`).then(
        (d) => ler(listaDoAsaas(assinaturaDoAsaas), d).data,
      ),
      Promise.all(
        STATUS_PAGOS.map((s) =>
          chamar("GET", `/payments?customer=${cliente}&status=${s}&limit=100`).then((d) => ler(listaDoAsaas(cobrancaDoAsaas), d).data),
        ),
      ).then((listas) => listas.flat()),
    ]);
    const recentes = [...assinaturas].sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
    const vivas = recentes.filter((s) => !ehTerminal(s));
    const principal = vivas[0] ?? null;
    const referencia = principal ?? recentes[0] ?? null;
    const daPrincipal = principal ? await cobrancasDaAssinatura(principal.id) : [];
    const hoje = dataCivilEmSaoPaulo(agora());
    const existe = daPrincipal.some((c) => PAGO.has(c.status));
    const corrente = daPrincipal.filter((c) => c.dueDate <= hoje).at(-1);
    const devidas = daPrincipal.filter((c) => c.status === "OVERDUE");
    if (corrente !== undefined && ESTORNADO.has(corrente.status)) devidas.push(corrente);
    const emAtraso = devidas.length > 0;
    const cicloDe = new Map(assinaturas.map((s) => [s.id, s.cycle]));
    const fins = pagas.flatMap((c) => {
      const ciclo = c.subscription ? cicloDe.get(c.subscription) : undefined;
      return ciclo === undefined ? [] : [fimDoDiaEmSaoPaulo(somarCiclo(c.dueDate, ciclo)).getTime()];
    });
    const aberta = daPrincipal.find((c) => c.status === "OVERDUE") ?? daPrincipal.find((c) => c.status === "PENDING");
    const maisAntiga = devidas.map((c) => c.dueDate).sort()[0];
    return {
      assinaturaRef: referencia?.id ?? null,
      existe,
      assinaturasVivas: vivas.length,
      cancelada: recentes.length > 0 && principal === null,
      // O Asaas não agenda cancelamento: o DELETE encerra na hora, e o acesso até o fim do pago vem de proximoVencimento.
      cancelaNoFim: false,
      emAtraso,
      vencidaDesde: maisAntiga === undefined ? null : fimDoDiaEmSaoPaulo(maisAntiga),
      proximoVencimento: fins.length > 0 ? new Date(Math.max(...fins)) : null,
      jaPagou: pagas.length > 0,
      emTesteNoProvedorAte: null,
      pagamentoSemAssinaturaViva: false,
      linkDePagamento: linkSeguro(aberta?.invoiceUrl),
      statusBruto: principal
        ? [principal.status, existe ? null : "sem_pagamento", emAtraso ? "em_atraso" : null].filter(Boolean).join(":")
        : referencia
          ? `${referencia.deleted === true ? "REMOVIDA" : referencia.status}:encerrada`
          : "sem_assinatura",
    };
  }

  /**
   * Chamado no AGENDAMENTO (§7e). Guarda: cobrança OVERDUE, ou PENDING que vence
   * até hoje em São Paulo, é o período em uso ainda não pago — mudar o valor
   * agora mexeria no boleto que o cliente já tem. Nunca comparar com
   * `nextDueDate`: é a próxima cobrança AINDA NÃO gerada, toda cobrança
   * existente vence antes dela, e a troca seria recusada sempre. Passada a
   * guarda, as pendentes são de períodos futuros (geradas até 40 dias antes) e
   * todas levam o valor novo.
   */
  async function trocarPlano(p: Parameters<AdaptadorDeCobranca["trocarPlano"]>[0]): Promise<void> {
    const hoje = dataCivilEmSaoPaulo(agora());
    const cobrancas = await cobrancasDaAssinatura(p.assinaturaRef);
    if (cobrancas.some((c) => c.status === "OVERDUE" || (c.status === "PENDING" && c.dueDate <= hoje))) {
      throw new ErroDoProvedor(null, "pagamento_do_periodo_pendente", false);
    }
    await chamar("PUT", `/subscriptions/${encodeURIComponent(p.assinaturaRef)}`, {
      value: p.plano.precoCents / 100,
      description: p.plano.nome,
      updatePendingPayments: true,
    });
  }

  /** DELETE encerra na hora e leva as cobranças abertas; o acesso até o fim do pago vem de `proximo_vencimento` (§7f). */
  async function cancelarNoFim(assinaturaRef: string): Promise<void> {
    try {
      await chamar("DELETE", `/subscriptions/${encodeURIComponent(assinaturaRef)}`);
    } catch (e) {
      if (!(e instanceof ErroDoProvedor && e.status === 404)) throw e;
    }
  }

  /** O Asaas não tem portal: "gerenciar" é pagar a cobrança aberta. Sem ela, `null` (a rota responde 409 `sem_portal`). */
  async function urlDeGerenciar(p: { clienteRef: string }): Promise<string | null> {
    return (await lerSituacao({ clienteRef: p.clienteRef })).linkDePagamento;
  }

  return {
    id: "asaas" as const,
    clienteExiste,
    testarChave,
    verificarWebhook: verificarWebhookAsaas,
    prepararWebhook,
    removerWebhooks,
    garantirCliente,
    iniciarAssinatura,
    lerSituacao,
    trocarPlano,
    cancelarNoFim,
    urlDeGerenciar,
  };
}
