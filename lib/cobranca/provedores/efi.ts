/**
 * O ADAPTADOR DO EFI BANK da cobrança do revendedor (spec
 * docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §6.2,
 * issue #4056).
 *
 * Por que o Efi existe ao lado de Stripe e Asaas: é conta brasileira que emite
 * boleto RECORRENTE com link de pagamento próprio, e é o provedor que uma parte
 * dos revendedores já usa. O encaixe é o MESMO: `AdaptadorDeCobranca`, registro
 * único em `./index`, nenhuma regra de negócio aqui.
 *
 * O que o Efi NÃO tem, e que muda o adaptador (medido na documentação oficial,
 * dev.efipay.com.br/docs/api-cobrancas, em 2026-11-05):
 * - **Cadastro de cliente.** O pagador viaja no corpo da cobrança/link, não há
 *   `POST /customers`. Então `clienteRef` é a NOSSA empresa (`org:<uuid>`) e
 *   `clienteExiste` só confere a forma da referência — não há cliente a sondar
 *   numa troca de chave. A guarda de conta da troca de chave é `testarChave`.
 * - **Listagem de assinaturas por cliente.** A leitura por `clienteRef` cai na
 *   lista de cobranças por `custom_id` (`GET /v1/charges`, filtro confirmado);
 *   quando quem chama já conhece a assinatura (`assinaturaRef`), a leitura é a
 *   dela (`GET /v1/subscription/:id`), que é a fonte boa.
 * - **Assinatura do aviso.** O Efi manda um `POST` com UM campo,
 *   `notification=<token>`, sem HMAC e sem horário; o token é o mesmo para toda
 *   mudança de estado daquela cobrança. Como o corpo não autentica nada, quem
 *   autentica é a URL que NÓS registramos na cobrança (`?token=<segredo>`), e a
 *   empresa viaja nela (`&org=<uuid>`) — é o único jeito de a rota achar a dona
 *   sem uma chamada de rede no caminho do aviso. O id do evento é o token com
 *   uma janela de 1 minuto: reentrega do MESMO aviso cai na mesma linha do
 *   arquivo (23505), e uma mudança de estado posterior acorda a leitura de novo
 *   — sem a janela, o aviso de `paid` seria descartado como duplicado do `new`.
 *
 * Regras que valem como no Asaas, cada uma com caso em efi.test.ts:
 * - A credencial é `client_id` + `client_secret` (OAuth2 em `/v1/authorize`,
 *   Basic Auth). A tela guarda UM campo, no formato `<modo>:<client_id>:<client_secret>`
 *   — o modo sai do que a pessoa digitou, nunca de adivinhação, e a chave de
 *   produção nunca é enviada ao sandbox (nem o contrário).
 * - Nada de credencial em query string, log, mensagem de erro, audit ou Sentry:
 *   `ErroDoProvedor` leva só status HTTP e um código; o `access_token` vive em
 *   memória do processo, nunca em resposta.
 * - O valor SEMPRE vem do servidor (`plano.precoCents`); o Efi não aceita moeda
 *   (só BRL), então moeda não é campo — e não há como o corpo do cliente
 *   renegociar preço.
 * - Sem SDK: `fetch` + `node:crypto`, como o resto do módulo.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { FUSO_PADRAO } from "@/lib/cobranca/fuso";
import { logger } from "@/lib/logger";

import {
  ErroDoProvedor,
  type AdaptadorDeCobranca,
  type Modo,
  type SinalDoWebhook,
  type Situacao,
  type WebhookPreparado,
} from "./contrato";

/** As bases oficiais. Qual vale sai do MODO que a credencial declara. */
export const EFI_API_BASE = {
  producao: "https://cobrancas.api.efipay.com.br",
  teste: "https://cobrancas-h.api.efipay.com.br",
} as const satisfies Record<Modo, string>;

const TENTATIVAS = 3;
const ESPERA_MAXIMA_MS = 5_000;
const TEMPO_LIMITE_MS = 20_000;
/** Folga para renovar o token ANTES de ele vencer (segundos). */
const FOLGA_DO_TOKEN_S = 60;
const HOSTS_DE_LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Código do provedor só sai do adaptador se for identificador: nada de texto livre. */
const CODIGO_SEGURO = /^[A-Za-z0-9_.:-]{1,80}$/;
/** `teste:`/`producao:` + client_id + client_secret, cada um com 8+ caracteres. */
const CREDENCIAL = /^(teste|producao):([^\s:]{8,128}):([^\s:]{8,256})$/;
const REF_DA_ORG = /^org:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** O token de notificação do Efi é um UUID. */
const TOKEN_DA_NOTIFICACAO = /^[0-9a-fA-F-]{16,64}$/;
const UUID = z.string().uuid();

export interface CredencialDoEfi {
  readonly modo: Modo;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface DependenciasDoEfi {
  /** A credencial em claro, lida A CADA chamada (a tela pode trocá-la). `null` = não configurada. */
  lerChave: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Só loopback (o dublê do e2e), e então só credencial de teste. Outra base lança na construção. */
  baseUrl?: string;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => Date;
  /** `marcaDaInstalacao(NEXT_PUBLIC_APP_URL)`: nomeia o plano e vai no User-Agent. */
  marca: string;
  /** `NEXT_PUBLIC_APP_URL`: a URL pública onde o aviso chega (sem query). `null` = não configurada. */
  urlPublica?: string | null;
  /** O token que autentica o aviso (`segredoDoWebhook`), lido a cada cobrança criada. */
  lerSegredo?: () => Promise<string | null>;
}

/** `teste`/`producao` pelo prefixo; `null` = não é credencial do Efi no formato da tela. */
export function modoDaChaveEfi(chave: string): Modo | null {
  return credencialDaChave(chave)?.modo ?? null;
}

/** Abre a credencial. Nunca loga nada: o que sai daqui é usado e descartado. */
export function credencialDaChave(chave: string): CredencialDoEfi | null {
  const m = CREDENCIAL.exec(chave.trim());
  if (!m) return null;
  return { modo: m[1] === "producao" ? "producao" : "teste", clientId: m[2]!, clientSecret: m[3]! };
}

function baseDeLoopback(base: string): boolean {
  if (!URL.canParse(base)) return false;
  const u = new URL(base);
  return (u.protocol === "http:" || u.protocol === "https:") && HOSTS_DE_LOOPBACK.has(u.hostname);
}

/** O `error`/`error_description` do Efi só sai do adaptador como identificador. */
export function erroDoEfi(status: number, corpo: unknown): ErroDoProvedor {
  const campos = corpo !== null && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
  // `error` é o identificador; `error_description` é texto livre (ecoa dado do
  // pagador) e só passa se, por acaso, for um identificador.
  const codigo = [campos.error, campos.error_description].find(
    (v): v is string => typeof v === "string" && CODIGO_SEGURO.test(v),
  );
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

const DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})/;
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

function partesEmSaoPaulo(instante: number) {
  const partes = PARTES_EM_SP.formatToParts(new Date(instante));
  const v = (tipo: Intl.DateTimeFormatPartTypes) => Number(partes.find((p) => p.type === tipo)?.value);
  return { ano: v("year"), mes: v("month"), dia: v("day"), hora: v("hour"), minuto: v("minute"), segundo: v("second") };
}

/** O dia civil em São Paulo de um instante (`AAAA-MM-DD`). */
export function dataCivilEmSaoPaulo(instante: Date): string {
  const p = partesEmSaoPaulo(instante.getTime());
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/**
 * O fim do dia civil do Efi em São Paulo (`expire_at` do boleto). O
 * deslocamento vem da tabela de fusos em duas voltas — nunca de um "-3" fixo.
 */
export function fimDoDiaEmSaoPaulo(data: string): Date | null {
  const m = DATA_CIVIL.exec(data);
  if (!m) return null;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const relogio = Date.UTC(a, mes - 1, d, 23, 59, 59);
  let instante = relogio + 3 * 3_600_000;
  for (let volta = 0; volta < 2; volta += 1) {
    const p = partesEmSaoPaulo(instante);
    instante = relogio - (Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - instante);
  }
  return new Date(instante);
}

/** Os 8 caracteres finais nunca são a credencial inteira: é o que a tela mostra. */
export function last4DaChaveEfi(chave: string): string | null {
  const c = credencialDaChave(chave);
  return c === null ? null : c.clientSecret.slice(-4);
}

/** O evento continua sendo `charge`: os estados que o Efi usa no histórico. */
const PAGO = new Set(["paid", "settled"]);
const ABERTO = new Set(["new", "waiting", "unpaid", "link"]);
const ENCERRADO = new Set(["canceled", "refunded", "contested"]);

const assinaturaDoEfi = z.object({
  subscription_id: z.union([z.number(), z.string()]),
  value: z.number().nullish(),
  status: z.string(),
  next_expire_at: z.string().nullish(),
  plan: z.object({ interval: z.number().nullish(), repeats: z.number().nullish() }).nullish(),
  history: z
    .array(z.object({ charge_id: z.union([z.number(), z.string()]).nullish(), status: z.string(), created_at: z.string().nullish() }))
    .nullish(),
});
type AssinaturaDoEfi = z.infer<typeof assinaturaDoEfi>;

const cobrancaDoEfi = z.object({
  id: z.union([z.number(), z.string()]),
  total: z.number().nullish(),
  status: z.string(),
  custom_id: z.string().nullish(),
  created_at: z.string().nullish(),
  payment: z
    .object({
      payment_method: z.string().nullish(),
      paid_at: z.string().nullish(),
      banking_billet: z.object({ link: z.string().nullish(), expire_at: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type CobrancaDoEfi = z.infer<typeof cobrancaDoEfi>;

const listaDeCobrancas = z.object({ code: z.number().nullish(), data: z.array(cobrancaDoEfi) });
const linkDaAssinatura = z.object({
  code: z.number().nullish(),
  data: z.object({
    subscription_id: z.union([z.number(), z.string()]),
    status: z.string().nullish(),
    payment_url: z.string().nullish(),
    expire_at: z.string().nullish(),
    charge: z.object({ id: z.union([z.number(), z.string()]), status: z.string().nullish() }).nullish(),
  }),
});
const linkDaCobranca = z.object({
  code: z.number().nullish(),
  data: z.object({
    charge_id: z.union([z.number(), z.string()]).nullish(),
    id: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
    payment_url: z.string().nullish(),
    expire_at: z.string().nullish(),
    payment: z.object({ banking_billet: z.object({ link: z.string().nullish() }).nullish() }).nullish(),
  }),
});
const planoDoEfi = z.object({ code: z.number().nullish(), data: z.object({ plan_id: z.union([z.number(), z.string()]) }) });
const listaDePlanos = z.object({
  code: z.number().nullish(),
  data: z.array(z.object({ plan_id: z.union([z.number(), z.string()]), name: z.string().nullish() })),
});
const tokenDoEfi = z.object({ access_token: z.string().min(1), expires_in: z.number().nullish() });

/** O `interval` do Efi é em meses e o plano é infinito (`repeats: null`). */
const MESES_DO_INTERVALO = { mes: 1, ano: 12 } as const;

/** O nome do plano no Efi carrega preço e ciclo: reusa o mesmo plano entre cobranças. */
function nomeDoPlano(p: { nome: string; precoCents: number; intervalo: keyof typeof MESES_DO_INTERVALO }): string {
  return `CRM ${p.nome} ${p.intervalo} ${p.precoCents}`;
}

export function criarAdaptadorEfi(dep: DependenciasDoEfi): AdaptadorDeCobranca {
  if (dep.baseUrl !== undefined && !baseDeLoopback(dep.baseUrl)) {
    throw new Error("base da API do Efi recusada: só a oficial ou loopback");
  }
  const buscar = dep.fetch ?? fetch;
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((pronto) => setTimeout(pronto, ms)));
  const agora = dep.agora ?? (() => new Date());
  const userAgent = `cobranca-do-revendedor/${dep.marca}`;

  /** Token OAuth do processo, por credencial. Guarda o SHA-256 da credencial, nunca ela. */
  const tokens = new Map<string, { token: string; expiraEm: number }>();

  async function credencial(): Promise<{ c: CredencialDoEfi; base: string }> {
    const chave = await dep.lerChave();
    const c = chave === null ? null : credencialDaChave(chave);
    if (c === null) throw new ErroDoProvedor(null, "sem_chave", false, true);
    if (dep.baseUrl === undefined) return { c, base: EFI_API_BASE[c.modo] };
    if (c.modo === "producao") throw new ErroDoProvedor(null, "chave_real_fora_do_efi", false, true);
    return { c, base: dep.baseUrl.replace(/\/+$/, "") };
  }

  /** A impressão da credencial é o que fica no mapa: a chave em claro não é guardada. */
  const impressao = (c: CredencialDoEfi) => createHash("sha256").update(`${c.modo}:${c.clientId}:${c.clientSecret}`, "utf8").digest("hex");

  async function token(base: string, c: CredencialDoEfi, forcar = false): Promise<string> {
    const chaveDoMapa = `${base}|${impressao(c)}`;
    const guardado = tokens.get(chaveDoMapa);
    if (!forcar && guardado !== undefined && guardado.expiraEm > agora().getTime()) return guardado.token;
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`, "utf8").toString("base64");
    const r = await buscar(`${base}/v1/authorize`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": userAgent,
        accept: "application/json",
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
      cache: "no-store",
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
    if (!r.ok) {
      throw erroDoEfi(r.status, await r.json().catch(() => null));
    }
    const lido = ler(tokenDoEfi, await r.json().catch(() => null));
    const ttl = (lido.expires_in ?? 600) - FOLGA_DO_TOKEN_S;
    tokens.set(chaveDoMapa, { token: lido.access_token, expiraEm: agora().getTime() + Math.max(ttl, 30) * 1000 });
    return lido.access_token;
  }

  /**
   * Uma chamada autenticada. 401 com token em mãos é token vencido (a tela pode
   * ter trocado a credencial): renova UMA vez. GET/PUT/DELETE repetem em
   * transitório; POST só em 429, que é recusa antes de processar — repetir um
   * POST que caiu na rede criaria a cobrança em dobro, e o Efi não tem chave de
   * idempotência (a idempotência das nossas criações é a RELEITURA).
   */
  async function chamar(
    metodo: "GET" | "POST" | "PUT" | "DELETE",
    caminho: string,
    corpo?: Record<string, unknown>,
  ): Promise<unknown> {
    const { c, base } = await credencial();
    const body = corpo === undefined ? undefined : JSON.stringify(corpo);
    let renovou = false;
    for (let tentativa = 1; ; tentativa += 1) {
      let erro: ErroDoProvedor;
      let pedida: string | null = null;
      try {
        const r = await buscar(`${base}${caminho}`, {
          method: metodo,
          headers: {
            authorization: `Bearer ${await token(base, c, renovou)}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            "user-agent": userAgent,
            accept: "application/json",
          },
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
        });
        if (r.ok) {
          if (r.status === 204) return null;
          return await r.json().catch(() => {
            // 2xx sem corpo só é resposta válida para DELETE/PUT de estado (§ Efi).
            if (metodo === "DELETE" || metodo === "PUT") return null;
            throw new ErroDoProvedor(r.status, "resposta_invalida", false);
          });
        }
        if (r.status === 401 && !renovou) {
          renovou = true;
          tentativa -= 1;
          continue;
        }
        erro = erroDoEfi(r.status, await r.json().catch(() => null));
        pedida = r.headers.get("retry-after") ?? r.headers.get("ratelimit-reset");
      } catch (e) {
        if (e instanceof ErroDoProvedor) throw e;
        erro = new ErroDoProvedor(null, "sem_resposta", true);
      }
      const repetivel = metodo === "POST" ? erro.status === 429 : erro.transitorio;
      if (!(tentativa < TENTATIVAS && repetivel)) throw erro;
      logger.warn("cobranca.efi.nova_tentativa", { status: erro.status, codigo: erro.codigo, tentativa });
      await esperar(espera(tentativa, pedida));
    }
  }

  /** Link que vira href, redirect ou botão de e-mail: só https (http só com o dublê em loopback). */
  function linkSeguro(u: string | null | undefined): string | null {
    if (!u || !URL.canParse(u)) return null;
    const esquema = new URL(u).protocol;
    if (esquema === "https:" || (esquema === "http:" && dep.baseUrl !== undefined)) return u;
    logger.warn("cobranca.link_invalido", { esquema });
    return null;
  }

  /** O aviso chega na NOSSA URL; a identidade vai na query porque o corpo não a tem. */
  function urlDoAviso(orgId: string, segredo: string): string | null {
    const publica = dep.urlPublica?.replace(/\/+$/, "");
    if (!publica || !URL.canParse(publica)) return null;
    const query = new URLSearchParams({ org: `org:${orgId}`, token: segredo });
    return `${publica}/api/v1/webhooks/cobranca/efi?${query}`;
  }

  const uuidDaOrg = (id: string): string => {
    const lido = UUID.safeParse(id);
    if (!lido.success) throw new ErroDoProvedor(null, "org_invalida", false);
    return lido.data;
  };

  /** O `clienteRef` é a nossa empresa (`org:<uuid>`): o Efi não cadastra cliente. */
  const orgDaRef = (ref: string): string => {
    const m = REF_DA_ORG.exec(ref);
    if (m === null) throw new ErroDoProvedor(404, "cliente_desconhecido", false);
    return uuidDaOrg(m[1]!);
  };

  /**
   * O Efi não tem recurso de cliente para sondar: a referência no formato da
   * casa existe por construção, e qualquer outra não é cliente DESTE adaptador
   * (404 → false, como manda o contrato).
   */
  async function clienteExiste(clienteRef: string): Promise<boolean> {
    return REF_DA_ORG.test(clienteRef);
  }

  async function testarChave(opcoes?: { modoExigido?: Modo }): ReturnType<AdaptadorDeCobranca["testarChave"]> {
    const chave = await dep.lerChave();
    const c = chave === null ? null : credencialDaChave(chave);
    if (c === null) return { ok: false, motivo: "chave_invalida" };
    // O modo sai da credencial: recusar ANTES de enviar é o que impede a chave
    // real de sair só para confirmar que é real.
    if ((opcoes?.modoExigido !== undefined && opcoes.modoExigido !== c.modo) || (c.modo === "producao" && dep.baseUrl !== undefined)) {
      return { ok: false, motivo: "modo_divergente", modo: c.modo };
    }
    try {
      await token(dep.baseUrl ?? EFI_API_BASE[c.modo], c, true);
      return { ok: true, modo: c.modo };
    } catch (e) {
      if (!(e instanceof ErroDoProvedor)) throw e;
      if (e.status === 401) return { ok: false, motivo: "chave_invalida" };
      if (e.status === 403) return { ok: false, motivo: "sem_permissao" };
      return { ok: false, motivo: "provedor_fora" };
    }
  }

  /**
   * O Efi não tem rota de cadastro de endpoint: o aviso mora na COBRANÇA
   * (`metadata.notification_url`), que criamos já com a URL e o token. Então o
   * ramo é sempre `manual`: a tela mostra a URL e o segredo, e quem cria a
   * cobrança (esta instalação) já os leva no corpo. `confirmar`/`desfazer` não
   * têm o que tocar no provedor.
   *
   * O segredo é REUSADO se já houver um: no Efi ele viaja na URL de cada
   * cobrança já criada, então sortear um novo a cada "Testar e conectar"
   * deixaria as faturas abertas avisando com um token que não vale mais (todo
   * aviso delas viraria 401). Para rotacionar, limpe `EFI_WEBHOOK_TOKEN` e
   * conecte de novo.
   */
  async function prepararWebhook(
    url: string,
    _emailDoDono: string,
  ): Promise<WebhookPreparado | { manual: { url: string; segredo: string; eventos: string[] } }> {
    const segredo = (await dep.lerSegredo?.()) ?? randomBytes(32).toString("base64url");
    const base = url.split("?")[0] ?? url;
    return { manual: { url: base, segredo, eventos: [...EVENTOS_DO_WEBHOOK_EFI] } };
  }

  /** Sem cadastro de endpoint, não há o que remover. */
  async function removerWebhooks(_url: string, _exceto?: string): Promise<number> {
    return 0;
  }

  /** O pagador viaja no corpo da cobrança; aqui só a referência estável da empresa. */
  async function garantirCliente(org: Parameters<AdaptadorDeCobranca["garantirCliente"]>[0]): Promise<string> {
    return `org:${uuidDaOrg(org.id)}`;
  }

  /**
   * Idempotência SEM chave do provedor: a RELEITURA antes de criar. Uma
   * assinatura/link em aberto da mesma empresa (`custom_id`) é o POST anterior
   * que processou e perdeu a resposta — devolvemos o link dela em vez de criar
   * a segunda cobrança.
   */
  async function cobrancasDaOrg(orgId: string, inicio: Date): Promise<CobrancaDoEfi[]> {
    const fim = new Date(agora().getTime() + 24 * 60 * 60 * 1000);
    const consulta = new URLSearchParams({
      charge_type: "subscription",
      custom_id: orgId,
      begin_date: dataCivilEmSaoPaulo(inicio),
      end_date: dataCivilEmSaoPaulo(fim),
      limit: "100",
    });
    const lido = ler(listaDeCobrancas, await chamar("GET", `/v1/charges?${consulta}`));
    return lido.data;
  }

  /** Reusa o plano do mesmo nome (preço/ciclo), em vez de criar um por checkout. */
  async function planoDoCatalogo(p: { nome: string; precoCents: number; intervalo: keyof typeof MESES_DO_INTERVALO }): Promise<string> {
    const nome = nomeDoPlano(p);
    const achados = ler(listaDePlanos, await chamar("GET", `/v1/plans?name=${encodeURIComponent(nome)}&limit=10`)).data;
    const meu = achados.find((x) => x.name === nome);
    if (meu) return String(meu.plan_id);
    return String(
      ler(planoDoEfi, await chamar("POST", "/v1/plan", { name: nome, interval: MESES_DO_INTERVALO[p.intervalo], repeats: null })).data.plan_id,
    );
  }

  /**
   * O checkout é o LINK de assinatura do Efi (`one-step/link`), que deixa o
   * pagador escolher boleto ou cartão na página deles — mesmo espírito do
   * `billingType: UNDEFINED` do Asaas. O teste grátis é NOSSO (a régua): o Efi
   * só aceita `trial_days` em assinatura de cartão, e aqui não há cartão ainda.
   * `urlDeVolta` não se aplica: quem volta é o "Já paguei", que relê.
   */
  async function iniciarAssinatura(
    p: Parameters<AdaptadorDeCobranca["iniciarAssinatura"]>[0],
  ): ReturnType<AdaptadorDeCobranca["iniciarAssinatura"]> {
    const orgId = orgDaRef(p.clienteRef);
    const emAberto = (await cobrancasDaOrg(orgId, new Date(agora().getTime() - 30 * 24 * 60 * 60 * 1000))).find(
      (c) => ABERTO.has(c.status) && linkSeguro(c.payment?.banking_billet?.link ?? null) !== null,
    );
    if (emAberto) {
      return {
        url: linkSeguro(emAberto.payment?.banking_billet?.link ?? null)!,
        expiraEm: emAberto.payment?.banking_billet?.expire_at ? fimDoDiaEmSaoPaulo(emAberto.payment.banking_billet.expire_at) : null,
        assinaturaRef: null,
        sessaoId: String(emAberto.id),
      };
    }
    const planoId = await planoDoCatalogo(p.plano);
    // Sem segredo gravado não há como autenticar o aviso: a cobrança nasce sem
    // `notification_url` e quem cura é a reconciliação (§8) — nunca um aviso
    // aceito sem prova.
    const segredo = (await dep.lerSegredo?.()) ?? null;
    const aviso = segredo === null ? null : urlDoAviso(orgId, segredo);
    const lido = ler(
      linkDaAssinatura,
      await chamar("POST", `/v1/plan/${encodeURIComponent(planoId)}/subscription/one-step/link`, {
        items: [{ name: p.plano.nome, value: p.plano.precoCents, amount: 1 }],
        metadata: { custom_id: orgId, ...(aviso === null ? {} : { notification_url: aviso }) },
        settings: { payment_method: "all", expire_at: dataCivilEmSaoPaulo(new Date(agora().getTime() + 7 * 24 * 60 * 60 * 1000)) },
      }),
    );
    const url = linkSeguro(lido.data.payment_url);
    if (url === null) throw new ErroDoProvedor(200, "resposta_invalida", false);
    return {
      url,
      expiraEm: lido.data.expire_at ? fimDoDiaEmSaoPaulo(lido.data.expire_at) : null,
      assinaturaRef: String(lido.data.subscription_id),
      // A cobrança do link é a "sessão" que a troca de plano expira (#2609).
      sessaoId: lido.data.charge ? String(lido.data.charge.id) : null,
    };
  }

  /**
   * O ajuste proporcional é uma cobrança AVULSA com link próprio (o pagador do
   * Efi é informado na página deles, não no corpo): `custom_id` é a chave de
   * idempotência — a releitura acha a cobrança em aberto do mesmo ajuste.
   */
  async function iniciarAjusteProporcional(p: Parameters<AdaptadorDeCobranca["iniciarAjusteProporcional"]>[0]) {
    const orgId = uuidDaOrg(p.orgId);
    const customId = `upgrade:${orgId}:${p.chaveIdempotencia}`;
    const consulta = new URLSearchParams({
      charge_type: "charge",
      custom_id: customId,
      begin_date: dataCivilEmSaoPaulo(new Date(agora().getTime() - 24 * 60 * 60 * 1000)),
      end_date: dataCivilEmSaoPaulo(new Date(agora().getTime() + 24 * 60 * 60 * 1000)),
      limit: "10",
    });
    const existentes = ler(listaDeCobrancas, await chamar("GET", `/v1/charges?${consulta}`)).data;
    const aberta = existentes.find((c) => ABERTO.has(c.status));
    if (aberta) {
      const url = linkSeguro(aberta.payment?.banking_billet?.link);
      if (url !== null) return { pagamentoRef: String(aberta.id), url };
    }
    const lido = ler(
      linkDaCobranca,
      await chamar("POST", "/v1/charge/one-step/link", {
        items: [{ name: `Ajuste proporcional — ${p.plano.nome}`, value: p.valorCents, amount: 1 }],
        metadata: { custom_id: customId },
      }),
    );
    const url = linkSeguro(lido.data.payment_url ?? lido.data.payment?.banking_billet?.link);
    const ref = lido.data.charge_id ?? lido.data.id;
    if (url === null || ref === null || ref === undefined) throw new ErroDoProvedor(200, "resposta_invalida", false);
    return { pagamentoRef: String(ref), url };
  }

  async function lerPagamentoProporcional(pagamentoRef: string): Promise<"pendente" | "pago" | "encerrado"> {
    const lido = ler(
      z.object({ code: z.number().nullish(), data: cobrancaDoEfi }),
      await chamar("GET", `/v1/charge/${encodeURIComponent(pagamentoRef)}`),
    );
    if (PAGO.has(lido.data.status)) return "pago";
    if (ABERTO.has(lido.data.status)) return "pendente";
    return "encerrado";
  }

  /** Cancelar a cobrança pendente mata o link com o preço antigo (#2609). 404 é o efeito desejado. */
  async function expirarSessao(sessaoId: string): Promise<void> {
    if (!/^\d+$/.test(sessaoId)) throw new ErroDoProvedor(422, "sessao_de_outro_provedor", false);
    try {
      await chamar("DELETE", `/v1/charge/${encodeURIComponent(sessaoId)}`);
    } catch (e) {
      if (e instanceof ErroDoProvedor && e.status === 404) return;
      throw e;
    }
  }

  function situacaoDaAssinatura(a: AssinaturaDoEfi): Situacao {
    const historico = a.history ?? [];
    const pagos = historico.filter((h) => PAGO.has(h.status));
    const emAberto = historico.some((h) => h.status === "unpaid");
    const viva = a.status === "active" || a.status === "new";
    const proximo = a.next_expire_at ? fimDoDiaEmSaoPaulo(a.next_expire_at) : null;
    return {
      assinaturaRef: String(a.subscription_id),
      // No Efi, `new` é o link emitido e ainda não pago: só conta como cobrança
      // viva depois do primeiro pagamento — o "incomplete" do Asaas.
      existe: pagos.length > 0,
      assinaturasVivas: viva ? 1 : 0,
      cancelada: !viva && (a.status === "canceled" || a.status === "expired"),
      // O Efi não agenda cancelamento: o cancelamento encerra na hora.
      cancelaNoFim: false,
      emAtraso: emAberto,
      vencidaDesde: null,
      proximoVencimento: proximo,
      periodoPagoDesde: pagos.length === 0 ? null : fimDoDiaEmSaoPaulo(pagos[pagos.length - 1]!.created_at ?? ""),
      jaPagou: pagos.length > 0,
      emTesteNoProvedorAte: null,
      pagamentoSemAssinaturaViva: false,
      linkDePagamento: null,
      // `value` do Efi já é centavos (mesma unidade de `cobranca_planos.preco_cents`).
      precoCents: a.value === null || a.value === undefined ? null : Math.round(a.value),
      statusBruto: [a.status, emAberto ? "em_atraso" : null].filter(Boolean).join(":"),
    };
  }

  /**
   * Leitura pela COBRANÇA (`custom_id` = empresa), quando quem chama não conhece
   * a assinatura. O Efi não lista assinaturas por cliente; a lista de cobranças
   * é o que existe. Conservadora de propósito: sem a assinatura, `assinaturaRef`
   * é `null` (o `aplicarLeitura` MANTÉM o id gravado) e o vencimento vem da
   * última cobrança paga — nunca maior que o período realmente pago.
   */
  function situacaoDasCobrancas(cobrancas: CobrancaDoEfi[]): Situacao {
    const pagas = cobrancas.filter((c) => PAGO.has(c.status));
    const ultima = [...pagas].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")).at(-1);
    const vencida = cobrancas.find((c) => c.status === "unpaid");
    const aberta = vencida ?? cobrancas.find((c) => ABERTO.has(c.status));
    return {
      assinaturaRef: null,
      existe: pagas.length > 0,
      assinaturasVivas: cobrancas.some((c) => ABERTO.has(c.status)) ? 1 : 0,
      cancelada: cobrancas.length > 0 && !cobrancas.some((c) => ABERTO.has(c.status)),
      cancelaNoFim: false,
      emAtraso: vencida !== undefined,
      vencidaDesde: vencida?.payment?.banking_billet?.expire_at ? fimDoDiaEmSaoPaulo(vencida.payment.banking_billet.expire_at) : null,
      proximoVencimento: ultima?.payment?.banking_billet?.expire_at ? fimDoDiaEmSaoPaulo(ultima.payment.banking_billet.expire_at) : null,
      periodoPagoDesde: ultima?.payment?.paid_at ? new Date(ultima.payment.paid_at) : null,
      jaPagou: pagas.length > 0,
      emTesteNoProvedorAte: null,
      pagamentoSemAssinaturaViva: false,
      linkDePagamento: linkSeguro(aberta?.payment?.banking_billet?.link ?? null),
      precoCents: aberta?.total ?? ultima?.total ?? null,
      statusBruto: aberta ? `${aberta.status}` : pagas.length > 0 ? "pago" : "sem_cobranca",
    };
  }

  async function lerSituacao(p: { clienteRef: string; assinaturaRef?: string | null }): Promise<Situacao> {
    if (p.assinaturaRef) {
      const lida = ler(
        z.object({ code: z.number().nullish(), data: assinaturaDoEfi }),
        await chamar("GET", `/v1/subscription/${encodeURIComponent(p.assinaturaRef)}`),
      );
      return situacaoDaAssinatura(lida.data);
    }
    const orgId = orgDaRef(p.clienteRef);
    return situacaoDasCobrancas(await cobrancasDaOrg(orgId, new Date(agora().getTime() - 400 * 24 * 60 * 60 * 1000)));
  }

  /**
   * O Efi só edita assinatura de CARTÃO (`PUT /v1/subscription/:id`, "only
   * credit card subscriptions can be modified"), e o nosso checkout é link com
   * boleto ou cartão — não há o que atualizar sem saber o meio. Recusa
   * definitiva (não transitória): quem chama audita `preco_no_provedor:
   * recusado` e o preço do banco passa a valer no próximo ciclo assistido.
   */
  async function trocarPlano(_p: Parameters<AdaptadorDeCobranca["trocarPlano"]>[0]): Promise<void> {
    throw new ErroDoProvedor(422, "troca_de_plano_nao_suportada", false);
  }

  /** `PUT /v1/subscription/:id/cancel`: encerra na hora; o acesso até o fim do pago vem de `proximo_vencimento`. */
  async function cancelarNoFim(assinaturaRef: string): Promise<void> {
    try {
      await chamar("PUT", `/v1/subscription/${encodeURIComponent(assinaturaRef)}/cancel`);
    } catch (e) {
      if (e instanceof ErroDoProvedor && e.status === 404) return;
      throw e;
    }
  }

  /** O Efi não tem portal: "gerenciar" é pagar a cobrança aberta. Sem ela, `null` (409 `sem_portal`). */
  async function urlDeGerenciar(p: { clienteRef: string; urlDeVolta: string }): Promise<string | null> {
    return (await lerSituacao({ clienteRef: p.clienteRef })).linkDePagamento;
  }

  return {
    id: "efi" as const,
    clienteExiste,
    testarChave,
    verificarWebhook: verificarWebhookEfi,
    prepararWebhook,
    removerWebhooks,
    garantirCliente,
    iniciarAssinatura,
    iniciarAjusteProporcional,
    lerPagamentoProporcional,
    expirarSessao,
    lerSituacao,
    trocarPlano,
    cancelarNoFim,
    urlDeGerenciar,
  };
}

/** Os avisos que o Efi manda: um por mudança de estado da cobrança. */
export const EVENTOS_DO_WEBHOOK_EFI = ["notification"] as const;

/** A janela do id do evento: reentrega dentro do minuto é o MESMO aviso. */
export const JANELA_DO_AVISO_MS = 60_000;

/**
 * O aviso do Efi: `POST` com `notification=<token>` (form ou JSON), sem HMAC e
 * sem horário. Quem autentica é a URL que registramos na cobrança — o token
 * (`?token=`) e a empresa (`?org=`). Comparação em tempo constante sobre o
 * SHA-256 dos dois lados: tamanho sempre igual, sem atalho que vaze prefixo.
 * Nunca lança; `null` = não é aviso nosso.
 */
export function verificarWebhookEfi(
  corpoCru: string,
  _headers: Headers,
  segredo: string,
  agora?: Date,
  url?: URL,
): SinalDoWebhook | null {
  if (!segredo || url === undefined) return null;
  const recebido = url.searchParams.get("token");
  if (!recebido) return null;
  const esperado = createHash("sha256").update(segredo, "utf8").digest();
  if (!timingSafeEqual(createHash("sha256").update(recebido, "utf8").digest(), esperado)) return null;
  const bruto = url.searchParams.get("org") ?? "";
  if (!REF_DA_ORG.test(bruto)) return null;

  let tokenDaNotificacao: string | null = null;
  try {
    const json: unknown = JSON.parse(corpoCru);
    if (json !== null && typeof json === "object") {
      const campo = (json as Record<string, unknown>).notification ?? (json as Record<string, unknown>).token;
      if (typeof campo === "string") tokenDaNotificacao = campo;
    }
  } catch {
    // É form-urlencoded, que é a forma documentada do Efi.
    const form = new URLSearchParams(corpoCru);
    tokenDaNotificacao = form.get("notification") ?? form.get("token");
  }
  if (tokenDaNotificacao === null || !TOKEN_DA_NOTIFICACAO.test(tokenDaNotificacao)) return null;

  // O MESMO token chega para toda mudança de estado daquela cobrança: sem a
  // janela, o aviso de `paid` cairia como duplicado do `new` e a empresa nunca
  // seria reativada. Dentro da janela, a reentrega do mesmo aviso é a mesma linha.
  const instante = (agora ?? new Date()).getTime();
  const janela = Math.floor(instante / JANELA_DO_AVISO_MS);
  return {
    eventoId: `efi:${tokenDaNotificacao}:${janela}`,
    tipo: "notification",
    clienteRef: bruto,
  };
}
