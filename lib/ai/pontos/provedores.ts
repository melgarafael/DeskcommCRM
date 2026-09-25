/**
 * OS PROVEDORES QUE O SISTEMA SABE USAR — a lista que substituiu o CHECK.
 *
 * A migration 0127 removeu os três CHECKs que prendiam `provider` em
 * `anthropic|openai|google` no banco, porque eles tornavam impossível cadastrar
 * OpenRouter (ou qualquer provedor novo, ou um modelo local) e porque cada
 * provedor novo viraria uma migration. Com a coluna aberta, a garantia de que a
 * tela não oferece opção inválida passa a morar aqui.
 *
 * A defesa em profundidade continua sendo dupla, e é importante entender de
 * onde vem cada metade:
 *
 *  - **Esta lista** é o que a tela OFERECE. Ela existe para o operador não
 *    escolher algo que o sistema não sabe executar.
 *  - **O registry** (`createDefaultRegistry`) é o que EXECUTA. Um provider que
 *    chegue até ele sem entrada correspondente falha com
 *    `LlmProviderUnknownError` — erro tipado que diz o que fazer, e não uma
 *    violação de constraint que o operador leria como bug do produto.
 *
 * As duas metades precisam concordar, e é justamente esse tipo de par que este
 * repo já viu divergir em silêncio (catálogo × preço). Por isso
 * `tests/unit/provedores-x-registry.test.ts` casa uma com a outra.
 *
 * `PROVEDORES` é só quem ESCREVE texto. Provedor que só decide (o Jev) mora em
 * `PROVEDORES_DE_DECISAO`, no fim deste arquivo — e o porquê está lá.
 */

/** Como a chave daquele provedor é validada e o que a tela precisa pedir. */
export interface ProvedorSuportado {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /** Uma frase sobre quando escolher este, para quem não acompanha o mercado. */
  quandoUsar: string;
  /**
   * O provedor aceita apontar para outro endpoint (é OpenAI-compatível)? É o
   * que habilita gateway próprio e, no roteiro, modelo local.
   */
  aceitaEndpointProprio: boolean;
  /** O catálogo de modelos vem de uma API pública que dá para sincronizar? */
  catalogoSincronizavel: boolean;
  /** Onde o operador pega a chave — a tela mostra o link. */
  ondePegarAChave: string;
  /** Como a chave começa — vira placeholder do campo, para a pessoa reconhecer que copiou a coisa certa. */
  prefixoDaChave: string;
}

export const PROVEDORES = [
  {
    id: "anthropic",
    rotulo: "Anthropic (Claude)",
    quandoUsar:
      "O padrão recomendado para conversar com o cliente: é o que melhor segue instruções longas e usa as ferramentas do CRM.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://console.anthropic.com/settings/keys",
    prefixoDaChave: "sk-ant-…",
  },
  {
    id: "openai",
    rotulo: "OpenAI (GPT)",
    quandoUsar:
      "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.openai.com/api-keys",
    prefixoDaChave: "sk-…",
  },
  {
    id: "google",
    rotulo: "Google (Gemini)",
    quandoUsar:
      "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://aistudio.google.com/apikey",
    prefixoDaChave: "AIza…",
  },
  {
    id: "openrouter",
    rotulo: "OpenRouter",
    quandoUsar:
      "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://openrouter.ai/keys",
    prefixoDaChave: "sk-or-…",
  },
  {
    id: "deepseek",
    rotulo: "DeepSeek",
    quandoUsar:
      "Muito barata e desconta sozinha o trecho repetido da conversa, sem você configurar nada — o custo cai para quem atende com um roteiro que não muda.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://platform.deepseek.com/api_keys",
    prefixoDaChave: "sk-…",
  },
  {
    id: "requesty",
    rotulo: "Requesty",
    quandoUsar:
      "Uma chave só para centenas de modelos de vários fabricantes, com a opção de manter o tráfego na Europa. Bom para comparar modelos sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://app.requesty.ai/api-keys",
    prefixoDaChave: "rqsty-…",
  },
] as const satisfies readonly ProvedorSuportado[];
// `as const satisfies` e não anotação de tipo: a anotação apagaria os literais
// e `Provider` viraria `string`, deixando o compilador aceitar qualquer texto
// como provedor — que é exatamente a garantia que esta lista existe para dar.

/**
 * Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais).
 *
 * Existe para os pontos de ESCRITA derivarem daqui em vez de repetir a lista:
 * a rota de credenciais, o schema de versão do agente e o diálogo da tela
 * tinham cada um a sua cópia, e quando a 0127 abriu o banco para a OpenRouter
 * as três continuaram recusando — o produto oferecia um provedor que não tinha
 * como ser cadastrado.
 */
export const IDS_DE_PROVEDOR = PROVEDORES.map((p) => p.id) as unknown as readonly [
  (typeof PROVEDORES)[number]["id"],
  ...(typeof PROVEDORES)[number]["id"][],
];

export const PROVEDOR_POR_ID: ReadonlyMap<string, ProvedorSuportado> = new Map(
  PROVEDORES.map((p) => [p.id, p]),
);

export function ehProvedorSuportado(id: string): boolean {
  return PROVEDOR_POR_ID.has(id);
}

/**
 * OS PROVEDORES QUE TÊM CHAVE MAS NÃO CONVERSAM — lista IRMÃ, não um campo.
 *
 * O Jev devolve decisão tipada (nota, escolha, sim/não), nunca texto. Se ele
 * entrasse em `PROVEDORES`, os doze consumidores de "quem escreve" (seletor do
 * agente, "Qual você contratou" do onboarding, Modelo padrão da empresa,
 * seletor de cada ponto) o ofereceriam como cérebro do atendimento, e todo
 * turno morreria em `LlmProviderUnknownError`.
 *
 * Por isso a separação é por LISTA e não por um campo `natureza` na lista
 * única: um consumidor NOVO de `PROVEDORES` simplesmente não vê o Jev, que é o
 * lado seguro. Quem precisa dele — só as superfícies de CHAVE — pede a união
 * explicitamente, e `tests/unit/provedores-de-decisao-catraca.test.ts` cobra
 * que ninguém mais a peça.
 */
export const PROVEDORES_DE_DECISAO = [
  {
    id: "typesafe",
    rotulo: "Jev (TypeSafe AI)",
    quandoUsar:
      "Não conversa com o cliente: toma decisões rápidas e baratas — como perceber se o cliente está irritado — geralmente em menos de um segundo. Trabalha junto com a sua IA principal.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://console.typesafe.ai/keys",
    prefixoDaChave: "apikey_…",
  },
] as const satisfies readonly ProvedorSuportado[];

export const IDS_DE_PROVEDOR_DE_DECISAO = PROVEDORES_DE_DECISAO.map(
  (p) => p.id,
) as unknown as readonly [
  (typeof PROVEDORES_DE_DECISAO)[number]["id"],
  ...(typeof PROVEDORES_DE_DECISAO)[number]["id"][],
];

/** Tudo o que tem chave cadastrável: a tela de Credenciais e a rota dela. */
export const PROVEDORES_COM_CHAVE = [...PROVEDORES, ...PROVEDORES_DE_DECISAO] as const;

export type ProvedorComChave = (typeof PROVEDORES_COM_CHAVE)[number]["id"];

export const IDS_COM_CHAVE = PROVEDORES_COM_CHAVE.map((p) => p.id) as unknown as readonly [
  ProvedorComChave,
  ...ProvedorComChave[],
];

export function ehProvedorDeDecisao(id: string): boolean {
  return (IDS_DE_PROVEDOR_DE_DECISAO as readonly string[]).includes(id);
}

/**
 * O nome de gente de qualquer provedor que aparece numa execução, inclusive o
 * Jev. Devolve só o rótulo, e não a lista: quem precisa NOMEAR (a tela de
 * Execuções) não pede a união, e a catraca continua valendo só para CHAVE.
 */
export function rotuloDoProvedor(id: string): string | undefined {
  return PROVEDORES_COM_CHAVE.find((p) => p.id === id)?.rotulo;
}
