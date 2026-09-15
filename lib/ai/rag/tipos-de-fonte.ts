/**
 * OS TIPOS DE MATERIAL QUE O AGENTE SABE LER — a lista que substituiu o CHECK.
 *
 * A migration 0181 removeu `ai_knowledge_sources_source_type_check` pelo mesmo
 * motivo da 0127 (que derrubou os CHECKs de `provider`): o CHECK tinha seis
 * valores com DOIS pares de sinônimos (`conversation`/`conversations`,
 * `catalog`/`nuvemshop_catalog`), nenhum valor para "documento avulso" — a
 * categoria que o produto mais precisa — e cada categoria nova viraria uma
 * migration. Com a coluna aberta, a garantia de que a tela não oferece valor
 * inválido passa a morar aqui.
 *
 * A defesa continua dupla, e é importante saber de onde vem cada metade:
 *
 *  - **Esta lista** é o que a tela OFERECE e o que a rota ACEITA.
 *  - **O indexador** (`workers/rag-indexer.ts`) é quem EXECUTA. Um tipo que
 *    chegue lá sem caminho de ingestão correspondente falha com motivo escrito
 *    na própria linha da fonte, e não com uma violação de constraint que o dono
 *    do negócio leria como bug do produto.
 *
 * A coluna fica FORA de `tests/invariants/vocabulario-banco-x-typescript.test.ts`
 * de propósito: aquele invariante cobre apenas colunas que JÁ têm CHECK, e
 * acrescentar esta ali recriaria pelo teste a constraint que a migration tirou.
 */

/** Como o material entra no sistema. É o que decide o caminho de ingestão. */
export type ComoSePreenche =
  /** A pessoa cola pares pergunta/resposta na tela. */
  | "texto_colado"
  /**
   * A pessoa envia um arquivo OU cola um texto corrido.
   *
   * Os dois caminhos terminam iguais de propósito: o texto colado é guardado
   * como arquivo `.md` e segue a mesma rota de extração. Um segundo destino para
   * "texto que não é pergunta/resposta" seria uma tabela a mais para manter, e a
   * pessoa que cola a política de troca não quer saber a diferença.
   */
  | "arquivo_ou_texto"
  /** Uma rotina do sistema alimenta sozinha; não há o que colar. */
  | "automatico";

export interface TipoDeFonte {
  id: string;
  /** Nome como o dono do negócio conhece. */
  rotulo: string;
  /** O que é, em uma frase, para quem não é engenheiro. */
  oQueE: string;
  comoSePreenche: ComoSePreenche;
  /**
   * Frase que a tela mostra no cartão vazio de um tipo `automatico`. Existe
   * porque "sem conteúdo" e "esperando a rotina" são estados diferentes e
   * pareciam o mesmo.
   */
  comoChega?: string;
}

export const TIPOS_DE_FONTE = [
  {
    id: "faq",
    rotulo: "Perguntas e respostas",
    oQueE:
      "As dúvidas que se repetem, com a resposta pronta. É o formato que o agente cita melhor, porque cada resposta chega inteira.",
    comoSePreenche: "texto_colado",
  },
  {
    id: "documento",
    rotulo: "Documento",
    oQueE:
      "Um texto do seu negócio — política de troca, tabela de preços, manual, contrato. Envie o arquivo (PDF, Markdown, CSV ou texto) ou cole o conteúdo.",
    comoSePreenche: "arquivo_ou_texto",
  },
  {
    id: "conversas",
    rotulo: "Conversas anteriores",
    oQueE:
      "Atendimentos já resolvidos que alguém marcou como aproveitáveis, com os dados pessoais removidos.",
    comoSePreenche: "automatico",
    comoChega:
      "Entra sozinha: conversas resolvidas que alguém marcar como aproveitáveis pela IA são anonimizadas e indexadas em lote.",
  },
  {
    id: "catalogo",
    rotulo: "Catálogo de produtos",
    oQueE: "Os produtos sincronizados da sua loja, com preço, descrição e disponibilidade.",
    comoSePreenche: "automatico",
    comoChega:
      "Entra sozinho: os produtos vêm da sincronização com a sua loja, não de conteúdo digitado aqui.",
  },
] as const satisfies readonly TipoDeFonte[];
// `as const satisfies` e não anotação de tipo: a anotação apagaria os literais e
// `TipoDeFonteId` viraria `string`, deixando o compilador aceitar qualquer texto
// como tipo de material — que é a garantia que esta lista existe para dar.

export type TipoDeFonteId = (typeof TIPOS_DE_FONTE)[number]["id"];

/** Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais). */
export const IDS_DE_TIPO_DE_FONTE = TIPOS_DE_FONTE.map((t) => t.id) as unknown as readonly [
  TipoDeFonteId,
  ...TipoDeFonteId[],
];

export const TIPO_DE_FONTE_POR_ID: ReadonlyMap<string, TipoDeFonte> = new Map(
  TIPOS_DE_FONTE.map((t) => [t.id, t]),
);

/**
 * Traduz os valores legados para o vocabulário de hoje.
 *
 * A migration 0181 já converteu o banco, mas um clone pode ter linha antiga
 * (`update.sh` roda sem `ON_ERROR_STOP` e pode ter parado antes), e a rota
 * continua ACEITANDO os nomes velhos de quem integrou por API. Traduzir na
 * borda é mais barato que espalhar `if` por seis arquivos.
 */
export function canonizarTipoDeFonte(bruto: string): TipoDeFonteId | null {
  const t = bruto.trim().toLowerCase();
  switch (t) {
    case "faq":
      return "faq";
    case "documento":
    case "policy":
      return "documento";
    case "conversas":
    case "conversations":
    case "conversation":
      return "conversas";
    case "catalogo":
    case "catalog":
    case "nuvemshop_catalog":
      return "catalogo";
    default:
      return null;
  }
}

/** Rótulo em português para mensagem de erro que alguém lê na tela. */
export function rotuloDoTipo(id: string): string {
  return TIPO_DE_FONTE_POR_ID.get(id)?.rotulo ?? id;
}

/** O tipo aceita conteúdo digitado/colado pela pessoa? */
export function aceitaTextoColado(id: string): boolean {
  const c = TIPO_DE_FONTE_POR_ID.get(id)?.comoSePreenche;
  return c === "texto_colado" || c === "arquivo_ou_texto";
}

/** O conteúdo colado é uma lista de pergunta/resposta (e não texto corrido)? */
export function ePerguntaEResposta(id: string): boolean {
  return TIPO_DE_FONTE_POR_ID.get(id)?.comoSePreenche === "texto_colado";
}

/** O tipo aceita arquivo enviado pela pessoa? */
export function aceitaArquivo(id: string): boolean {
  return TIPO_DE_FONTE_POR_ID.get(id)?.comoSePreenche === "arquivo_ou_texto";
}

/** A pessoa alimenta este material, ou uma rotina alimenta sozinha? */
export function ePreenchidoPorRotina(id: string): boolean {
  return TIPO_DE_FONTE_POR_ID.get(id)?.comoSePreenche === "automatico";
}
