/**
 * Avaliações do Google (Perfil da Empresa) — a parte PURA.
 *
 * ─── O que este módulo decide, e por que fora do banco ──────────────────────
 *
 * Três coisas, todas prováveis sem rede e sem Supabase: (a) o que é uma
 * avaliação legível, (b) a qual conta/local ela pertence, e (c) o que falta na
 * instalação para poder lê-las. A ingestão (`./ingest`) e a sincronização
 * (`./sincronizar`) só orquestram o que foi decidido aqui.
 *
 * ─── O filtro de escopo é a regra, não um detalhe ──────────────────────────
 *
 * A API v4 devolve o `name` de cada avaliação no formato
 * `accounts/{conta}/locations/{local}/reviews/{id}`. Uma resposta pode vir com
 * avaliações de OUTRA localização — conta com vários locais, troca de
 * credencial no meio do caminho, dublê de teste respondendo o que não devia. O
 * escopo é conferido pelo `name` COMPLETO, e o que não casa é descartado e
 * contado: avaliação de outro projeto não entra na Central desta organização
 * nem por engano, e o descarte não é silencioso (o número volta no resultado).
 */

/** Escopo OAuth que a leitura usa. A escrita (fatia 2) usa o mesmo. */
export const ESCOPO_DE_AVALIACOES = "https://www.googleapis.com/auth/business.manage";

/**
 * As variáveis do app OAuth da INSTALAÇÃO (o projeto Google da própria
 * empresa, como pede a issue #3510). Mesmo contrato da Agenda e do Ads: sem o
 * par, o recurso não some — a tela diz o que falta.
 */
export const VARIAVEIS_DE_AVALIACOES = [
  "GOOGLE_BUSINESS_OAUTH_CLIENT_ID",
  "GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET",
] as const;

export interface AmbienteDasAvaliacoes {
  GOOGLE_BUSINESS_OAUTH_CLIENT_ID?: string;
  GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET?: string;
}

export interface AvaliacaoDoGoogle {
  /** `reviews/{id}`, estável: é a chave de idempotência da mensagem. */
  id: string;
  /** `accounts/{conta}/locations/{local}` — o projeto a que ela pertence. */
  escopo: string;
  /** Nome de exibição do avaliador. A API não devolve telefone nem e-mail. */
  autor: string;
  /** Id opaco do avaliador, quando vem; é o que amarra o contato entre avaliações. */
  autorId: string | null;
  /** 1 a 5. Nota desconhecida NÃO vira 0: a avaliação é descartada. */
  nota: number;
  /** Texto da avaliação; vazio quando a pessoa só deu nota. */
  texto: string;
  criadaEm: string | null;
  atualizadaEm: string | null;
  /** Já respondida no Google — a fatia 2 é que responde. */
  respondida: boolean;
}

export interface LeituraDeAvaliacoes {
  avaliacoes: AvaliacaoDoGoogle[];
  /** Quantas vieram e foram descartadas por serem de outro projeto. */
  deOutroEscopo: number;
  /** Quantas não tinham o mínimo para virar item na Central. */
  invalidas: number;
}

const NOTA_POR_ESTRELA: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/** `accounts/{conta}/locations/{local}` — a conta e o local do canal. */
export function escopoDaAvaliacao(conta: string, local: string): string {
  return `accounts/${texto(conta)}/locations/${texto(local)}`;
}

/** Prefixo do `name` de uma avaliação dentro do escopo. */
export function prefixoDoEscopo(escopo: string): string {
  return `${texto(escopo).replace(/\/+$/, "")}/reviews/`;
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Lê a resposta da API v4 e devolve só o que é deste escopo.
 *
 * Não lança por item torto: uma avaliação sem autor ou com nota desconhecida é
 * descartada e CONTADA. Lançar por causa de um item faria uma avaliação
 * estranha derrubar a sincronização inteira — e o operador veria "falha ao ler
 * avaliações" sem nenhuma avaliação faltando de verdade.
 */
export function lerAvaliacoes(itens: unknown, escopo: string): LeituraDeAvaliacoes {
  const lista = Array.isArray(itens) ? itens : [];
  const prefixo = prefixoDoEscopo(escopo);
  const avaliacoes: AvaliacaoDoGoogle[] = [];
  let deOutroEscopo = 0;
  let invalidas = 0;

  for (const item of lista) {
    const bruto = objeto(item);
    if (!bruto) {
      invalidas += 1;
      continue;
    }
    const nome = texto(bruto.name);
    if (!nome.startsWith(prefixo)) {
      // Veio de outra conta ou de outro local: é o caso cruzado que a Central
      // não pode mostrar. `name` sem prefixo nenhum conta como inválida, e não
      // como "de outro escopo" — são diagnósticos diferentes.
      if (nome.includes("/locations/")) deOutroEscopo += 1;
      else invalidas += 1;
      continue;
    }
    const nota = NOTA_POR_ESTRELA[texto(bruto.starRating).toUpperCase()];
    const avaliador = objeto(bruto.reviewer);
    const autor = texto(avaliador?.displayName);
    if (!nota || !autor) {
      invalidas += 1;
      continue;
    }
    const id = nome.slice(prefixo.length);
    if (!id) {
      invalidas += 1;
      continue;
    }
    avaliacoes.push({
      id,
      escopo: texto(escopo).replace(/\/+$/, ""),
      autor,
      // A API v4 não devolve id do avaliador — só nome e foto. A foto não é
      // identidade (muda, some, e duas pessoas podem não ter): o vínculo do
      // contato é o nome de exibição, e é o que a fatia 1 tem.
      autorId: null,
      nota,
      texto: typeof bruto.comment === "string" ? bruto.comment.trim() : "",
      criadaEm: texto(bruto.createTime) || null,
      atualizadaEm: texto(bruto.updateTime) || null,
      respondida: objeto(bruto.reviewReply) !== null,
    });
  }

  return { avaliacoes, deOutroEscopo, invalidas };
}

/**
 * A nota que a LISTA da Central mostra, lida do `metadata` da conversa.
 *
 * A conversa carrega `metadata.google_business.nota` (escrito pela ingestão).
 * Devolver `null` fora da faixa 1..5 é deliberado: nota torta — de banco
 * anterior, de dublê, de escrita manual — não vira "★ 0" nem "★ 9" na tela, e
 * o item continua legível como conversa comum.
 */
export function notaDaAvaliacaoNaConversa(metadata: unknown): number | null {
  const google = objeto(objeto(metadata)?.google_business);
  const nota = google?.nota;
  return typeof nota === "number" && Number.isInteger(nota) && nota >= 1 && nota <= 5 ? nota : null;
}

export interface PreparoDasAvaliacoes {
  /** `true` quando a instalação tem o par OAuth do projeto Google. */
  pronta: boolean;
  /** Nomes das variáveis que faltam, na ordem em que a tela as lista. */
  faltando: string[];
  /**
   * A frase para a TELA. `null` quando está tudo configurado.
   *
   * Existe porque controle que só desabilita não ensina: o operador vê que não
   * pode e não descobre por quê. Mesmo contrato de
   * `faltaParaConectarOGoogle()` na Agenda.
   */
  explicacao: string | null;
}

/**
 * O que falta para ler avaliações nesta instalação.
 *
 * Nunca lança e nunca esconde: sem credencial a sincronização devolve
 * `sem_credencial` com estes nomes, e a tela mostra a frase. É o critério
 * "sem credencial, a tela explica o que falta em vez de quebrar".
 */
export function oQueFaltaParaLerAvaliacoes(ambiente: AmbienteDasAvaliacoes): PreparoDasAvaliacoes {
  const faltando = VARIAVEIS_DE_AVALIACOES.filter((nome) => texto(ambiente[nome]).length === 0);
  if (faltando.length === 0) return { pronta: true, faltando: [], explicacao: null };
  return {
    pronta: false,
    faltando: [...faltando],
    explicacao:
      `As avaliações do Google ainda não podem ser lidas: falta configurar ` +
      `${faltando.join(" e ")} com o projeto Google da própria empresa ` +
      `(escopo ${ESCOPO_DE_AVALIACOES}).`,
  };
}
