/**
 * O CONTRATO DE PROVEDOR DE COBRANÇA (spec cobrança do revendedor §6).
 *
 * O provedor é INSUMO, não fonte de regra: teste grátis, régua e limites moram
 * no nosso banco. O que o provedor responde é a `Situacao`, sempre RELIDA na
 * API; o webhook só acorda a leitura (`SinalDoWebhook`). Stripe (PR 3a) e Asaas
 * (PR 3b) cabem no mesmo encaixe; Mercado Pago, depois.
 *
 * Sem SDK: cada adaptador recebe `fetch` e a chave por injeção, lida a cada
 * uso. Toda falha de transporte, de HTTP ou de forma da resposta sai do
 * adaptador como `ErroDoProvedor` — nunca `TypeError`, `ZodError` ou o corpo do
 * provedor —, porque é a classe dele que decide o `ultimo_erro` da assinatura e
 * o 503/502 das rotas, e porque URL, cabeçalho e corpo vão parar em log e Sentry.
 */
import {
  PROVEDORES_DE_COBRANCA,
  type ErroDeLeitura,
  type Intervalo,
  type Modo,
  type ProvedorDeCobranca,
} from "@/lib/cobranca/vocabulario";

export { PROVEDORES_DE_COBRANCA };
export type { Modo, ProvedorDeCobranca };

export interface PlanoParaProvedor {
  readonly id: string;
  readonly nome: string;
  readonly precoCents: number;
  /** Moeda sempre BRL (CHECK de `cobranca_planos.moeda`). */
  readonly intervalo: Intervalo;
}

/** O que o webhook AUTORIZA: acordar a leitura. Nunca é fonte de estado. */
export interface SinalDoWebhook {
  readonly eventoId: string;
  readonly tipo: string;
  readonly clienteRef: string | null;
}

/** A única verdade que o provedor nos dá — relida na API. Tradução: `lib/cobranca/estado.ts`. */
export interface Situacao {
  /** Principal: a mais recente NÃO terminal; senão a mais recente. */
  readonly assinaturaRef: string | null;
  /** Principal não terminal E com o 1º pagamento confirmado. */
  readonly existe: boolean;
  /** Não terminais, inclusive as à espera do 1º pagamento (>1 = cobrança dupla). */
  readonly assinaturasVivas: number;
  /** Nenhuma não terminal e a mais recente é terminal. */
  readonly cancelada: boolean;
  readonly cancelaNoFim: boolean;
  /** O provedor diz que a principal está devendo. */
  readonly emAtraso: boolean;
  /** Só quando o provedor sabe a data (Asaas); Stripe: null. */
  readonly vencidaDesde: Date | null;
  /** Fim do período pago. */
  readonly proximoVencimento: Date | null;
  /** Houve pagamento confirmado (> 0) em qualquer assinatura do cliente. */
  readonly jaPagou: boolean;
  /** Principal em teste no provedor (Stripe `trialing`): fim do teste lá. Asaas: sempre null. */
  readonly emTesteNoProvedorAte: Date | null;
  /** Pagou fatura de assinatura já terminal. */
  readonly pagamentoSemAssinaturaViva: boolean;
  /** Só de cobrança da principal NÃO terminal. */
  readonly linkDePagamento: string | null;
  /** Diagnóstico: vai para o audit `cobranca.estado_mudou`. */
  readonly statusBruto: string;
}

/** Só status HTTP e código do provedor. Nunca URL, header ou corpo (vão para log/Sentry). */
export class ErroDoProvedor extends Error {
  override readonly name = "ErroDoProvedor";

  constructor(
    readonly status: number | null,
    readonly codigo: string,
    readonly transitorio: boolean,
    readonly credencialInvalida = false,
  ) {
    super(`provedor ${status ?? "sem_resposta"} ${codigo}`);
  }
}

/**
 * O `ultimo_erro` que uma leitura falha grava na assinatura. O estado fica
 * intacto em todos os casos. Chave que não serve → `credencial_invalida`;
 * transitório (rede, 429, 5xx) → `provedor_fora`; o resto — inclusive o cliente
 * que não existe na conta da chave nova — → `leitura_invalida`, que a Visão
 * geral mostra ao dono.
 */
export function paraErroDeLeitura(erro: unknown): ErroDeLeitura {
  if (!(erro instanceof ErroDoProvedor)) return "leitura_invalida";
  if (erro.credencialInvalida) return "credencial_invalida";
  return erro.transitorio ? "provedor_fora" : "leitura_invalida";
}

/**
 * `modoExigido` recusa a chave do OUTRO modo antes de enviá-la ao provedor:
 * chave real nunca sai só para confirmar que é real.
 */
export type ResultadoDoTesteDaChave =
  | { ok: true; modo: Modo }
  | { ok: false; motivo: "chave_invalida" | "sem_permissao" | "provedor_fora" }
  | { ok: false; motivo: "modo_divergente"; modo: Modo };

/**
 * O endpoint novo já existe no provedor; os antigos só saem em `confirmar()`,
 * que quem chama roda DEPOIS de gravar o segredo. `desfazer()` apaga o novo
 * quando a gravação falha — o antigo, com o segredo que está no banco, segue valendo.
 */
export interface WebhookPreparado {
  readonly segredo: string;
  confirmar(): Promise<void>;
  desfazer(): Promise<void>;
}

export interface AdaptadorDeCobranca {
  readonly id: ProvedorDeCobranca;
  testarChave(opcoes?: { modoExigido?: Modo }): Promise<ResultadoDoTesteDaChave>;
  prepararWebhook(
    url: string,
    emailDoDono: string,
  ): Promise<WebhookPreparado | { manual: { url: string; segredo: string; eventos: string[] } }>;
  /** Apaga os endpoints DESTA instalação (mesma URL ou mesma marca), menos `exceto`. Devolve quantos. */
  removerWebhooks(url: string, exceto?: string): Promise<number>;
  /**
   * O cliente existe na conta DESTA chave? 404 → false; o resto sobe como
   * `ErroDoProvedor`. É a guarda da troca de chave: chave de OUTRA conta com
   * empresas pagando pararia a leitura de todas (Stripe `GET /customers/{id}`,
   * Asaas `GET /customers/{id}`).
   */
  clienteExiste(clienteRef: string): Promise<boolean>;
  /** null = inválido. Corpo CRU. Tempo constante. Nunca lança. */
  verificarWebhook(corpoCru: string, headers: Headers, segredo: string, agora: Date): SinalDoWebhook | null;
  garantirCliente(org: { id: string; nome: string; email: string; documento: string | null }): Promise<string>;
  iniciarAssinatura(p: {
    clienteRef: string;
    orgId: string;
    plano: PlanoParaProvedor;
    trialAte: Date | null;
    urlDeVolta: string;
    chaveIdempotencia: string;
  }): Promise<{ url: string; expiraEm: Date | null; assinaturaRef: string | null }>;
  lerSituacao(p: { clienteRef: string }): Promise<Situacao>;
  /** "Vale a partir da próxima cobrança gerada." Pode recusar com ErroDoProvedor não transitório. */
  trocarPlano(p: { assinaturaRef: string; plano: PlanoParaProvedor }): Promise<void>;
  cancelarNoFim(assinaturaRef: string): Promise<void>;
  urlDeGerenciar(p: { clienteRef: string; urlDeVolta: string }): Promise<string | null>;
}
