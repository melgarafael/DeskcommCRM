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
  /**
   * Provedor local/self-host, sem billing real e sem "chave" no sentido
   * comum (ex.: Ollama rodando na própria VPS do cliente). Quando `true`, a
   * tela não deve tratar `ondePegarAChave` como "onde comprar acesso" — o
   * link aponta para a documentação do projeto, não para uma página de
   * billing. Ausente (undefined) equivale a `false` para os provedores
   * hospedados.
   */
  local?: boolean;
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
  },
  {
    id: "openai",
    rotulo: "OpenAI (GPT)",
    quandoUsar:
      "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    rotulo: "Google (Gemini)",
    quandoUsar:
      "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    rotulo: "OpenRouter",
    quandoUsar:
      "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://openrouter.ai/keys",
  },
  {
    id: "nvidia",
    rotulo: "NVIDIA NIM",
    quandoUsar:
      "Catálogo de modelos open-weight (Llama, Nemotron e outros) hospedado pela NVIDIA, com API compatível OpenAI — bom para quem já tem crédito NVIDIA ou quer um provedor alternativo aos três principais.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://build.nvidia.com",
  },
  {
    id: "ollama",
    rotulo: "Ollama (local)",
    quandoUsar:
      "Para rodar um modelo na própria máquina ou VPS do cliente, sem chave paga e sem enviar dados a terceiros — exige que o operador tenha o Ollama instalado e acessível pela rede.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    // Não é billing — é a documentação do projeto. `local: true` avisa a tela
    // para não tratar este link como "onde comprar acesso".
    ondePegarAChave: "https://ollama.com",
    local: true,
  },
  {
    id: "deepseek",
    rotulo: "DeepSeek",
    quandoUsar:
      "Custo por token muito baixo, com modelos fortes em raciocínio e código — boa opção para operações de alto volume sensíveis a preço.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "qwen",
    rotulo: "Qwen (Alibaba Cloud)",
    quandoUsar:
      "Modelos da família Qwen via Dashscope, com bom suporte a chinês e português — alternativa para quem já opera na nuvem da Alibaba.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://dashscope.console.aliyun.com/apiKey",
  },
  {
    id: "zhipu",
    rotulo: "Zhipu AI (GLM)",
    quandoUsar:
      "Modelos GLM da Zhipu AI, com API compatível OpenAI — alternativa de custo competitivo para chat e ferramentas.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "moonshot",
    rotulo: "Moonshot AI (Kimi)",
    quandoUsar:
      "Modelos Kimi da Moonshot AI, com contexto longo — alternativa para quem precisa de janelas grandes a custo menor que os três principais.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.moonshot.cn/console/api-keys",
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
