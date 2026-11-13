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

/**
 * Onde fica a empresa que recebe o dado — o que a cláusula de transferência
 * internacional do documento do operador imprime (#4520).
 *
 * O valor é DECLARADO, não deduzido: não existe geolocalização de chamada de
 * API que responda essa pergunta, e chutar país é pior do que dizer que o
 * provedor não declara. `"desconhecido"` é resposta de primeira classe
 * justamente por isso — o texto legal diz "não declara o país; consulte a
 * política do provedor" em vez de omitir a linha.
 *
 * `"operador"` é o provedor personalizado: o endpoint é do próprio operador, e
 * o dado não sai do servidor dele (o mesmo caso do modelo local que o roteiro
 * prevê).
 */
export type PaisDoProvedor = "US" | "CN" | "UE" | "operador" | "desconhecido";

/** Como a chave daquele provedor é validada e o que a tela precisa pedir. */
export interface ProvedorSuportado {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /**
   * A sede declarada de quem processa o texto — lida pela cláusula 9 do
   * documento do operador (`lib/legal/operador.ts`). Ver `PaisDoProvedor`.
   */
  pais: PaisDoProvedor;
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

/**
 * O LOGIN POR ASSINATURA (#1639) — vocabulário da credencial E da conversa.
 *
 * A linha em `ai_provider_credentials` deste provedor guarda um PAR DE TOKENOS
 * (access + refresh), não uma chave de API: quem a lê é o painel de conexão da
 * empresa, a renovação e o resolvedor da assinatura — nunca um leitor genérico
 * (`lib/ai/credentials.ts` recusa este provider de propósito: mandaria o JSON
 * dos tokens como se fosse chave).
 *
 * A constante mora aqui (e não em `./reserva-da-assinatura`) porque é
 * vocabulário: quem escreve e quem lê importam do mesmo lugar, sem ciclo. Ela
 * vem ANTES de `PROVEDORES` porque é dentro da lista, na entrada do provedor,
 * que este id é usado — um `const` declarado depois da lista estouraria em TDZ
 * na hora de avaliar o próprio array.
 */
export const PROVEDOR_POR_ASSINATURA = "openai-assinatura";

export const PROVEDORES = [
  {
    id: "anthropic",
    rotulo: "Anthropic (Claude)",
    // Sede da Anthropic PBC, em São Francisco. O texto da conversa sai do
    // servidor do operador e é processado nos Estados Unidos.
    pais: "US",
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
    // OpenAI, em São Francisco.
    pais: "US",
    quandoUsar:
      "Na configuração padrão, transcreve áudio. Para indexar material, uma chave OpenAI ou OpenRouter atende ao mesmo modelo de embedding.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.openai.com/api-keys",
    prefixoDaChave: "sk-…",
  },
  {
    id: PROVEDOR_POR_ASSINATURA,
    rotulo: "OpenAI pela assinatura (ChatGPT)",
    // A assinatura é da OpenAI: mesma sede do `openai`, mesmo destino do dado.
    pais: "US",
    quandoUsar:
      "Conecte sua conta pessoal do ChatGPT dentro dos limites da assinatura; para operação em volume, prefira uma chave de API da organização. Uma chave da própria organização pode servir de reserva.",
    // A assinatura não se aponta para outro endereço nem sincroniza catálogo:
    // o endpoint é o da própria OpenAI e o modelo vem do que a conta tem.
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    // Não existe chave a copiar aqui: quem conecta é o painel de Credenciais
    // desta instalação (Sign in with ChatGPT por PKCE). O link aponta para o
    // serviço cuja ASSINATURA este provedor usa; catálogo e inferência SIWC
    // usam a API pública oficial em `api.openai.com`.
    ondePegarAChave: "https://chatgpt.com/",
    // Placeholder do campo de chave, que para este provedor não tem o que
    // colar: o texto já diz a recusa antes de a pessoa tentar.
    prefixoDaChave: "conectado pelo login — não se cola chave",
  },
  {
    id: "google",
    rotulo: "Google (Gemini)",
    // Google LLC, em Mountain View.
    pais: "US",
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
    // OpenRouter, Inc., nos Estados Unidos.
    pais: "US",
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
    // DeepSeek (Hangzhou DeepSeek Artificial Intelligence), na China.
    pais: "CN",
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
    // NÃO DECLARADO, e de propósito: a Requesty oferece manter o tráfego na
    // Europa (`quandoUsar` acima), mas o país da empresa que responde a API
    // não está numa fonte que este repo possa citar com data. O documento diz
    // "não declara o país; consulte a política do provedor" em vez de inventar
    // uma sede — a cláusula 9 é assinada por quem opera.
    pais: "desconhecido",
    quandoUsar:
      "Uma chave só para centenas de modelos de vários fabricantes, com a opção de manter o tráfego na Europa. Bom para comparar modelos sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://app.requesty.ai/api-keys",
    prefixoDaChave: "rqsty-…",
  },
  {
    id: "custom",
    rotulo: "Provedor personalizado (compatível com OpenAI)",
    // O endpoint é do próprio operador (gateway, LiteLLM, proxy corporativo):
    // não há terceiro a nomear, e o dado fica no servidor dele.
    pais: "operador",
    quandoUsar:
      "Endpoint seu que fala a API da OpenAI — OmniRouter, 9Router, LiteLLM hospedado ou proxy corporativo, num endereço público. Você informa o endereço (base URL) e a chave, e o CRM conversa com ele como conversa com a OpenAI.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    // O provedor personalizado NÃO tem portal de chave — quem emite a chave é
    // o gateway do próprio operador. O valor fica só porque o tipo exige um
    // endereço para os outros; o diálogo esconde o link "Onde pegar a chave"
    // quando este provedor está escolhido, e a página que explica o recurso é
    // `docs/features/provedor-personalizado.md`. TLD `.example` de propósito:
    // é o reservado para documentação (RFC 2606/6761), que a catraca de marca
    // não trata como host de terceiro — e o link não é clicável, é escondido.
    ondePegarAChave: "https://docs.example/provedor-personalizado",
    prefixoDaChave: "sk-…",
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
    // A mesma declaração que a política de privacidade já publica: TypeSafe AI,
    // nos Estados Unidos.
    pais: "US",
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

/**
 * O LOGIN POR ASSINATURA — por que esta entrada fica em `PROVEDORES_COM_CHAVE`
 * embora não se pareça com uma chave.
 *
 * `PROVEDORES_COM_CHAVE` é a união das duas listas (`tests/unit/provedores-de-decisao-catraca.test.ts`
 * cobra que seja exatamente elas), e a assinatura entrou em `PROVEDORES`
 * porque o seletor do agente, o padrão da empresa e o validador de escrita
 * derivam de lá: é a lista de quem CONVERSA, e este provedor conversa.
 *
 * O que NÃO mudou: colar o par de tokens como chave continua sendo o erro que
 * este provider existe para não cometer — quem lê a linha é o painel de
 * conexão, a renovação e `resolveOrgLlmConfig` (um leitor genérico mandaria o
 * JSON dos tokens no lugar da chave), e `validateProviderKey` devolve recusa
 * explicando que a credencial nasce pelo login.
 */
export type ProvedorComChave =
  | (typeof PROVEDORES_COM_CHAVE)[number]["id"]
  | typeof PROVEDOR_POR_ASSINATURA;

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
