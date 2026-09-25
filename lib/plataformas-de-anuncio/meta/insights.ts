/**
 * A LEITURA de métricas da plataforma de anúncios da Meta.
 *
 * Irmão de `conversions.ts`: os dois são os únicos arquivos do repo, fora de
 * `lib/channels/`, que podem escrever o nome do endpoint — e é por isso que
 * existem separados. Tudo que sabe o formato do fio mora aqui, e some daqui para
 * dentro se a plataforma mudar. Este arquivo NÃO cruza dados nem calcula
 * derivadas: isso é `tabela-de-campanhas.ts`, que é puro e testável sem rede.
 *
 * ─── O que foi VERIFICADO contra a API viva, e não suposto ──────────────────
 *
 * Sondagem de 2026-09-02 contra a v22.0, numa conta real. Cinco achados que
 * mudam o código e que nenhuma leitura de documentação teria entregado:
 *
 * 1. `results` e `cost_per_result` EXISTEM e são o caminho certo para a coluna
 *    "Resultado". Cada um traz um `indicator` dizendo QUAL ação a plataforma
 *    contou (`actions:onsite_conversion.messaging_conversation_started_7d`,
 *    `actions:offsite_conversion.fb_pixel_lead`). Isto substitui derivar o
 *    action_type do `objective` da campanha — que erraria em campanha com ad
 *    sets de objetivos diferentes, porque a plataforma resolve por ad set.
 *
 * 2. `video_3_sec_watched_actions` FOI REMOVIDO. Pedi-lo devolve erro 100
 *    ("is not valid for fields param"), e o erro derruba a resposta INTEIRA —
 *    não é um campo omitido, é a chamada perdida. Era o numerador clássico do
 *    Hook Rate.
 *
 * 3. `video_continuous_2_sec_watched_actions` é aceito e volta VAZIO mesmo em
 *    campanha com vídeo. Não serve de substituto: pedi-lo custa e não entrega.
 *
 * 4. Campos de vídeo em campanha SEM vídeo são simplesmente OMITIDOS da linha —
 *    não dão erro. Por isso pedimos todos sempre, numa chamada só, em vez de
 *    descobrir antes quais campanhas têm criativo em vídeo (o que exigiria
 *    varrer `/ads` + creatives de cada campanha: N+1 para o mesmo resultado).
 *
 * 5. Campanha sem veiculação no período volta SEM `cpm`, SEM `ctr`, SEM `cpc`, e
 *    com `results: [{ indicator: "…" }]` — indicador presente e `values`
 *    AUSENTE. Quatro das sete campanhas da conta sondada estavam assim. Um
 *    `results[0].values[0].value` estoura na maioria das linhas reais.
 *
 * ─── Cota ───────────────────────────────────────────────────────────────────
 *
 * A conta sondada respondeu `ads_api_access_tier: "development_access"`, que tem
 * cota baixa. Cada abertura da tela gasta 2 chamadas (campanhas + insights), e o
 * botão "Atualizar" gasta 2 de novo. Por isso o 613/17 é classificado como
 * `limite_de_chamadas` e ganha mensagem própria na tela, em vez de virar "erro
 * ao carregar" — o operador precisa saber que a espera resolve.
 */
import { VERSAO_PADRAO_DA_GRAPH } from "@/lib/graph-version";
import { logger } from "@/lib/logger";
import type {
  ContaDeAnuncio,
  FalhaDeLeitura,
  ResultadoDeLeitura,
} from "../types";

/**
 * A MESMA versão que `conversions.ts` fixa, e pelo mesmo motivo: a instalação
 * não deve conviver com duas versões da mesma plataforma. Subir de versão é uma
 * mudança deliberada, feita num arquivo só (`lib/graph-version.ts`), depois de
 * reconferir os campos — a lição do achado 2 acima é justamente que campo
 * válido some entre versões.
 */
const VERSAO_DA_API = VERSAO_PADRAO_DA_GRAPH;

const TEMPO_LIMITE_MS = 20_000;

/**
 * Teto de páginas por leitura.
 *
 * `paging.next` vem da plataforma, e seguir um cursor alheio sem teto é um laço
 * infinito esperando um bug do outro lado. 20 páginas × 500 campanhas cobre
 * qualquer conta que caiba nesta tela; acima disso o problema é a tela, não o
 * limite.
 */
const MAXIMO_DE_PAGINAS = 20;

/**
 * Os campos de insight, no nível de campanha — os de sempre.
 *
 * `video_3_sec_watched_actions` NÃO está aqui, e não é esquecimento — ver o
 * achado 2 no cabeçalho. Acrescentá-lo de volta derruba a tela inteira.
 */
const CAMPOS_DE_INSIGHTS_BASE = [
  "campaign_id",
  "campaign_name",
  "spend",
  "impressions",
  "reach",
  "cpm",
  "ctr",
  "frequency",
  "cpc",
  "results",
  "cost_per_result",
  "video_play_actions",
  "video_thruplay_watched_actions",
];

/**
 * Os dois nomes que o Connect rate (issue #920) acrescentou — e de onde cada
 * número vem, porque a conta não é óbvia olhando a lista:
 *
 * O Connect rate usa `actions[landing_page_view]` (numerador) e
 * `inline_link_clicks` (denominador). O denominador não existia no payload que a
 * tela já pedia: `ctr` e `cpc` são razões e `cpc` conta cliques TOTAIS —
 * contagem de cliques no link não estava em campo nenhum. Os dois nomes novos
 * pegam carona na MESMA leitura de insights, então não há chamada nova.
 */
const CAMPOS_DO_CONNECT_RATE = ["actions", "inline_link_clicks"];

const CAMPOS_DE_INSIGHTS = [...CAMPOS_DE_INSIGHTS_BASE, ...CAMPOS_DO_CONNECT_RATE].join(",");

/**
 * O pedido de socorro: a MESMA leitura, sem os dois nomes novos.
 *
 * É com esta lista que `lerInsights` repete a chamada quando a plataforma recusa
 * um dos dois — o desfecho que já aconteceu nesta rota com
 * `video_3_sec_watched_actions` (achado 2 do cabeçalho) e que, sem a repetição,
 * derruba a tela INTEIRA: o payload de insights alimenta todas as colunas, não
 * só a nova.
 */
const CAMPOS_DE_INSIGHTS_SEM_CONNECT_RATE = CAMPOS_DE_INSIGHTS_BASE.join(",");

const CAMPOS_DE_CAMPANHA = ["id", "name", "status", "effective_status", "objective"].join(",");

// ─────────────────────────────────────────────────────────────────────────────
// O formato do fio — tipos do que a plataforma devolve
// ─────────────────────────────────────────────────────────────────────────────

/** Métrica que vem como lista rotulada (`results`, `cost_per_result`). */
export interface MetricaIndicada {
  indicator?: string;
  /** AUSENTE quando a campanha não veiculou. Ver achado 5. */
  values?: { value?: string }[];
}

/** Métrica que vem como lista por action_type (`video_play_actions`, `actions`). */
export interface AcaoDaPlataforma {
  action_type?: string;
  value?: string;
}

/** Nome antigo, de quando só as métricas de vídeo usavam esta forma. */
export type AcaoDeVideo = AcaoDaPlataforma;

export interface LinhaDeInsightCrua {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  cpm?: string;
  ctr?: string;
  frequency?: string;
  cpc?: string;
  results?: MetricaIndicada[];
  cost_per_result?: MetricaIndicada[];
  video_play_actions?: AcaoDaPlataforma[];
  video_thruplay_watched_actions?: AcaoDaPlataforma[];
  /** Lista de ações por `action_type` — é de onde sai `landing_page_view`. */
  actions?: AcaoDaPlataforma[];
  /** Cliques no link, como string. Ausente quando a campanha não recebeu clique. */
  inline_link_clicks?: string;
}

export interface CampanhaCrua {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
}

interface RespostaPaginada<T> {
  data?: T[];
  paging?: { next?: string };
}

interface ErroGraph {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    type?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação de erro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Códigos de token. 190 é o genérico ("Invalid OAuth access token"); 102 é
 * sessão inválida; 463 é token expirado; 467 é token revogado. Todos pedem a
 * mesma coisa de quem opera: colar um token novo.
 */
const CODIGOS_DE_TOKEN = new Set([102, 190, 463, 467]);

/**
 * Códigos de permissão. 10 e 200 são "permissão negada"; 272 é conta fora do
 * alcance do token; 294 é falta de permissão de gestão. Token novo NÃO resolve
 * se ele for gerado com o mesmo escopo — a tela precisa citar `ads_read`.
 */
const CODIGOS_DE_PERMISSAO = new Set([10, 200, 272, 294]);

/**
 * Cota. 4 e 17 são limite de app/usuário, 32 é limite de página, 613 é
 * `Calls to this api have exceeded the rate limit`, e a família 80000-80004 é o
 * limite por caso de uso de negócio (o que o header
 * `x-business-use-case-usage` reporta).
 */
const CODIGOS_DE_COTA = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004]);

export function classificarErroGraph(
  status: number,
  codigo: number | null,
): FalhaDeLeitura {
  if (codigo !== null) {
    if (CODIGOS_DE_TOKEN.has(codigo)) return "token_invalido";
    if (CODIGOS_DE_PERMISSAO.has(codigo)) return "permissao_insuficiente";
    if (CODIGOS_DE_COTA.has(codigo)) return "limite_de_chamadas";
    // 100 = campo/parâmetro inválido. NÃO é problema de quem opera: ou é bug
    // nosso, ou a plataforma removeu o campo da versão que pedimos — exatamente
    // o que aconteceu com `video_3_sec_watched_actions` entre a v21 e a v22.
    // Mandar o operador "tentar mais tarde" desperdiça o dia dele: o conserto é
    // um deploy.
    if (codigo === 100) return "campo_invalido";
  }
  // 5xx sem código conhecido é instabilidade do outro lado.
  if (status >= 500) return "transitorio";
  // 4xx que não casou com nada acima: tratado como token, que é a causa mais
  // provável e a única com ação clara para quem lê a tela.
  return status === 401 || status === 403 ? "token_invalido" : "transitorio";
}

// ─────────────────────────────────────────────────────────────────────────────
// O transporte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET numa URL da Graph, seguindo `paging.next` até o fim.
 *
 * O token vai no HEADER, nunca na query string — mesma regra de `conversions.ts`
 * e do CLAUDE.md (anti-pattern 12): token em URL vaza para log de proxy e para o
 * breadcrumb do Sentry. `paging.next` VOLTA com o token embutido na query,
 * porque a plataforma o monta assim; por isso ele é reescrito antes de ser
 * seguido, e nunca registrado em log.
 */
async function buscarPaginado<T>(
  urlInicial: string,
  token: string,
  contexto: string,
): Promise<ResultadoDeLeitura<T[]>> {
  const acumulado: T[] = [];
  let url: string | null = urlInicial;
  let pagina = 0;

  while (url && pagina < MAXIMO_DE_PAGINAS) {
    pagina += 1;

    let resposta: Response;
    try {
      resposta = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        // Sob demanda de verdade: a tela promete "Atualizar" e um cache aqui
        // devolveria número velho com cara de novo.
        cache: "no-store",
        signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      });
    } catch (erro) {
      return {
        ok: false,
        falha: "transitorio",
        detalhe: erro instanceof Error ? erro.message : "falha de rede",
      };
    }

    const texto = await resposta.text().catch(() => "");

    if (!resposta.ok) {
      let codigo: number | null = null;
      let mensagem = texto.slice(0, 400);
      try {
        const json = JSON.parse(texto) as ErroGraph;
        if (typeof json.error?.code === "number") codigo = json.error.code;
        if (json.error?.message) mensagem = json.error.message;
      } catch {
        // Corpo não-JSON num erro é gateway/WAF no meio. Fica o texto cru.
      }
      const falha = classificarErroGraph(resposta.status, codigo);
      // A mensagem da plataforma entra no log; o token, nunca — nem o `url`,
      // que a partir da segunda página o carrega na query.
      logger.warn("[ads.meta.insights] leitura recusada", {
        contexto,
        status: resposta.status,
        codigo,
        falha,
      });
      return { ok: false, falha, detalhe: mensagem };
    }

    let json: RespostaPaginada<T>;
    try {
      json = JSON.parse(texto) as RespostaPaginada<T>;
    } catch {
      return { ok: false, falha: "transitorio", detalhe: "resposta ilegível da plataforma" };
    }

    acumulado.push(...(json.data ?? []));
    url = json.paging?.next ?? null;
  }

  return { ok: true, dados: acumulado };
}

/**
 * Exportada, e não copiada: o endereço da Graph e a versão da API existem UMA
 * vez neste eixo. Uma segunda cópia em `hierarquia-do-anuncio.ts` sobreviveria à
 * próxima subida de versão sem ninguém notar — e a lição do achado 2 no
 * cabeçalho é justamente que campo válido some entre versões.
 */
export function montarUrl(caminho: string, parametros: Record<string, string>): string {
  const url = new URL(`https://graph.facebook.com/${VERSAO_DA_API}/${caminho}`);
  for (const [chave, valor] of Object.entries(parametros)) {
    url.searchParams.set(chave, valor);
  }
  return url.toString();
}

/** As contas de anúncio que o token alcança. */
export async function listarContas(
  token: string,
): Promise<ResultadoDeLeitura<ContaDeAnuncio[]>> {
  const url = montarUrl("me/adaccounts", {
    fields: "account_id,name,currency,account_status",
    limit: "200",
  });

  interface ContaCrua {
    account_id?: string;
    name?: string;
    currency?: string;
    account_status?: number;
  }

  const resultado = await buscarPaginado<ContaCrua>(url, token, "adaccounts");
  if (!resultado.ok) return resultado;

  const contas = resultado.dados
    .filter((c): c is ContaCrua & { account_id: string } => Boolean(c.account_id))
    .map((c) => ({
      id: `act_${c.account_id}`,
      nome: c.name ?? c.account_id,
      moeda: c.currency ?? "BRL",
      status: typeof c.account_status === "number" ? c.account_status : 0,
    }));

  return { ok: true, dados: contas };
}

/**
 * As campanhas da conta, com `status` e `effective_status`.
 *
 * Chamada SEPARADA do insights, e não é escolha nossa: o endpoint de insights
 * não expõe estado de campanha. É por isso que a tela faz duas chamadas por
 * atualização, e é o que dobra o custo em cota.
 */
export async function lerCampanhas(
  token: string,
  contaId: string,
): Promise<ResultadoDeLeitura<CampanhaCrua[]>> {
  const url = montarUrl(`${encodeURIComponent(contaId)}/campaigns`, {
    fields: CAMPOS_DE_CAMPANHA,
    limit: "500",
  });
  return buscarPaginado<CampanhaCrua>(url, token, "campaigns");
}

/**
 * A frase que a tela mostra quando a coluna do Connect rate não veio.
 *
 * Sem nome de campo e sem jargão de propósito — e sem o motivo cru do
 * provedor, que é do log: quem olha o painel precisa saber que o número é
 * AUSENTE (não zero) e que o resto da tabela está de pé. O motivo, para quem
 * for investigar, está na linha de log que acompanha esta repetição.
 */
export const AVISO_DO_CONNECT_RATE_AUSENTE =
  "A plataforma não devolveu as métricas do Connect rate nesta leitura: a coluna ficou sem número (vazio não é zero) e o resto da tabela está completo.";

/**
 * Os insights do período, no nível de campanha.
 *
 * `time_range` com datas explícitas em vez de `date_preset`: o preset é resolvido
 * no fuso da CONTA, e a tela oferece um seletor de intervalo que precisa
 * corresponder exatamente ao que foi pedido.
 *
 * ─── A repetição sem os campos do Connect rate ──────────────────────────────
 *
 * Na v22.0 um nome inválido em `fields` devolve erro 100 e derruba a resposta
 * INTEIRA. Não é hipótese nesta rota: `video_3_sec_watched_actions` fez isso
 * (achado 2 do cabeçalho). E o payload de insights alimenta TODAS as colunas da
 * tabela, não só a coluna nova — então o desfecho de um nome que a plataforma
 * deixou de aceitar é a tela toda cair, sem nada que quem opera possa fazer: o
 * conserto é um deploy.
 *
 * O Connect rate (#920) acrescentou dois nomes, e com eles a chance desse
 * desfecho voltar. Daí a regra: erro de CAMPO INVÁLIDO ⇒ UMA repetição da mesma
 * leitura sem os dois nomes novos. A coluna fica "—" (a tela já sabe dizer que
 * não houve medição), as outras colunas continuam de pé, e a cota fica igual:
 * zero chamada a mais no caminho bom, uma no caminho em que hoje a tela morre.
 *
 * Nenhuma outra falha repete: token, permissão, cota e rede não melhoram com um
 * pedido diferente — e repetir cota gasta justamente o que está faltando.
 */
export async function lerInsights(
  token: string,
  contaId: string,
  de: string,
  ate: string,
): Promise<ResultadoDeLeitura<LinhaDeInsightCrua[]>> {
  const caminho = `${encodeURIComponent(contaId)}/insights`;
  const parametros = {
    level: "campaign",
    time_range: JSON.stringify({ since: de, until: ate }),
    limit: "500",
  };

  const leitura = await buscarPaginado<LinhaDeInsightCrua>(
    montarUrl(caminho, { ...parametros, fields: CAMPOS_DE_INSIGHTS }),
    token,
    "insights",
  );

  if (leitura.ok || leitura.falha !== "campo_invalido") return leitura;

  // O motivo CRU que a plataforma devolveu vai junto: é ele que separa "este
  // campo não existe mais nesta versão da Graph" (conserto é deploy) de "esta
  // conta não tem permissão para esta métrica" (conserto é token) — duas ações
  // diferentes para quem opera. `detalhe` não carrega token: o transporte o põe
  // no header e a URL de paginação é reescrita antes de qualquer log.
  logger.warn("[ads.meta.insights] campo inválido: repetindo sem os campos do Connect rate", {
    contexto: "insights",
    causa: leitura.falha,
    detalhe: leitura.detalhe,
  });

  const repetida = await buscarPaginado<LinhaDeInsightCrua>(
    montarUrl(caminho, { ...parametros, fields: CAMPOS_DE_INSIGHTS_SEM_CONNECT_RATE }),
    token,
    "insights",
  );

  // A repetição fecha a AÇÃO (a tela não morre) e a informação ABRE: sem esta
  // ressalva, a coluna vazia fica indistinguível de zero — trocaríamos um erro
  // visível por um erro invisível, que ninguém vai investigar.
  if (!repetida.ok) return repetida;
  return { ...repetida, aviso: AVISO_DO_CONNECT_RATE_AUSENTE };
}
