/**
 * O PAR (PROVEDOR, MODELO) É CONFERIDO ANTES DE QUALQUER BYTE SAIR — issue #2377.
 *
 * A instalação pode operar com OpenAI, Anthropic ou OpenRouter, e um
 * `organizations.settings.llm` legado nasceu como `{provider: 'openai',
 * default_model: 'claude-sonnet-5'}`: o gatilho semeava o par da Anthropic e o
 * instalador antigo trocava só o provedor. Um id desse mandava à OpenAI um
 * modelo que ela não conhece, e o defeito só aparecia no caminho que o usava —
 * mídia, classificação, leitura — enquanto a tela mostrava só o provedor geral.
 *
 * Este módulo é a régua única dos cinco pontos de execução:
 *
 *  - `lib/agent-engine/edge/llm/run-model-call.ts`  (seam do agente)
 *  - `lib/ai/gateway-binding.ts`                    (pilha antiga: sentimento, resposta, ensaio)
 *  - `workers/media-derive-worker.ts`               (mídia: transcrição, visão, pdf)
 *  - `lib/ai/runtime/agent.ts`                      (agentes internos)
 *  - `lib/ai/embed.ts`                              (leitura/indexação da base)
 *
 * Duas regras governam o que aqui se afirma:
 *
 *  1. Só se recusa o que se pode PROVAR. O provedor precisa ser um que o
 *     produto conhece (`anthropic`, `openai`, `google`, `deepseek`) ou um
 *     agregador (`openrouter`, `requesty`, `custom`), e o modelo precisa trazer
 *     um prefixo de fabricante conhecido ou pertencer a uma família que só
 *     um deles executa (`claude-*`, `gpt-*`, `gemini-*`, `deepseek-*`).
 *     Recusa errada é pior que a recusa faltando: a segunda deixa o provedor
 *     responder com o 400 dele, a primeira cala um ponto que funcionava.
 *  2. O QUE SE VALIDA é o par que vai SAIR, não a preferência do painel. Um id
 *     com rota própria (`openai/gpt-5-mini`) executa na OpenAI mesmo quando a
 *     organização está em Anthropic — a rota do id é coerência, não divergência.
 *     O par errado é `openai` + `claude-sonnet-5`: provedor de um, modelo de outro.
 */
import { logger } from "@/lib/logger";
import { IDS_DE_PROVEDOR, PROVEDOR_POR_ASSINATURA } from "./pontos/provedores";

/**
 * Endereço que executa o catálogo de OUTRO fabricante: a assinatura (#1672)
 * fala com os modelos da OpenAI (`gpt-5`), então o par se confere como `openai`.
 * Sem isto, todo turno de agente na assinatura era recusado antes de sair.
 */
const FABRICANTE_DO_ENDERECO: Readonly<Record<string, string>> = {
  [PROVEDOR_POR_ASSINATURA]: "openai",
};

export type ResultadoDoPar =
  | { valido: true }
  | { valido: false; motivo: string };

/** Provedores que servem QUALQUER id: o prefixo do fabricante é parte do endereço. */
const AGREGADORES: ReadonlySet<string> = new Set(["openrouter", "requesty", "custom"]);

/**
 * Os provedores diretos, DERIVADOS de `./pontos/provedores.ts` e nunca escritos
 * à mão aqui: o catálogo é a fonte única e `provedores-x-registry` reprovava
 * qualquer arquivo que listasse os três à mão (issue #2377).
 */
const PROVEDORES_DIRETOS: ReadonlySet<string> = new Set(
  IDS_DE_PROVEDOR.filter((id) => !AGREGADORES.has(id)),
);

/**
 * Famílias de modelo que só um fabricante executa — é o que permite recusar um
 * id BARE (`claude-sonnet-5`, sem prefixo) num provedor que não é o dele.
 * Prefixo vazio (`anthropic/claude-x`) já resolve antes, pelo próprio nome.
 */
const FAMILIAS: ReadonlyArray<{ re: RegExp; provedor: string }> = [
  { re: /^claude[-./]/i, provedor: "anthropic" },
  { re: /^gpt-/i, provedor: "openai" },
  { re: /^o[0-9]/i, provedor: "openai" },
  { re: /^gemini-/i, provedor: "google" },
  { re: /^deepseek-/i, provedor: "deepseek" },
];

/**
 * O provedor que um id pertence — `null` quando não dá para afirmar.
 *
 * Prefixo desconhecido (`fabricante-x/modelo-y`) devolve `null` de propósito:
 * agregadores usam exatamente esse formato, e pertencer a um deles não é erro.
 */
export function provedorNaturalDoModelo(modelId: string): string | null {
  const id = String(modelId ?? "").trim();
  if (id === "") return null;
  const nome = parteAposARota(id);
  if (nome !== null) {
    const rotulo = id.slice(0, id.indexOf("/")).toLowerCase();
    return PROVEDORES_DIRETOS.has(rotulo) ? rotulo : null;
  }
  return provedorDaFamilia(id);
}

/** O nome do modelo depois da rota, ou `null` quando o id não traz rota. */
function parteAposARota(id: string): string | null {
  const corte = id.indexOf("/");
  return corte > 0 ? id.slice(corte + 1) : null;
}

/** O fabricante de um NOME de modelo (`claude-sonnet-5` → anthropic), ou `null`. */
function provedorDaFamilia(nome: string): string | null {
  for (const familia of FAMILIAS) {
    if (familia.re.test(nome)) return familia.provedor;
  }
  return null;
}

/**
 * O par é executável pelo provedor que vai atender a chamada?
 *
 * `provider` aqui é o provedor do ENDEREÇO — quem recebe a requisição — e não a
 * preferência gravada na organização. Inválido devolve o motivo em PT-BR, já
 * pronto para ir para o log e para a mensagem de erro do chamador.
 *
 * Três perguntas, nesta ordem:
 *  1. a rota do id (`openai/…`) bate com o endereço?
 *  2. o NOME do modelo é da família de quem a rota anuncia?
 *     (`openai/claude-sonnet-5` responde as duas com "não" na segunda — é o
 *     par legado que a issue #2377 descreve.)
 *  3. sem rota, o nome pertence a outro fabricante?
 */
export function validarParProvedorModelo(provider: unknown, modelId: unknown): ResultadoDoPar {
  const enderecoBruto = String(provider ?? "").trim().toLowerCase();
  const provedor = FABRICANTE_DO_ENDERECO[enderecoBruto] ?? enderecoBruto;
  const modelo = String(modelId ?? "").trim();

  if (provedor === "") {
    return { valido: false, motivo: "o provedor da chamada ficou vazio — não há endereço para onde ir" };
  }
  if (modelo === "") {
    return { valido: false, motivo: `o provedor "${provedor}" não recebeu modelo nenhum` };
  }
  // Agregador serve id de qualquer fabricante — o prefixo é endereço lá.
  if (AGREGADORES.has(provedor)) return { valido: true };
  // Provedor fora do catálogo do produto (proxy antigo, id legado): quem sabe
  // o que ele executa é quem o cadastrou, não esta régua.
  if (!PROVEDORES_DIRETOS.has(provedor)) return { valido: true };

  const nome = parteAposARota(modelo);
  if (nome === null) {
    // Id BARE: só o nome diz de quem é.
    const familia = provedorDaFamilia(modelo);
    if (familia === null || familia === provedor) return { valido: true };
    return { valido: false, motivo: parErrado(modelo, familia, provedor) };
  }

  const rotulo = modelo.slice(0, modelo.indexOf("/")).toLowerCase();
  if (!PROVEDORES_DIRETOS.has(rotulo)) {
    // Rota de agregador ou de fabricante que não conhecemos: conservador.
    return { valido: true };
  }
  if (rotulo !== provedor) {
    return { valido: false, motivo: parErrado(modelo, rotulo, provedor) };
  }
  const familia = provedorDaFamilia(nome);
  if (familia === null || familia === rotulo) return { valido: true };
  return { valido: false, motivo: `a rota "${rotulo}" anuncia o modelo "${nome}", mas o nome é da família "${familia}"` };
}

function parErrado(modelo: string, provedorDoModelo: string, provedorDaChamada: string): string {
  return (
    `o modelo "${modelo}" pertence ao provedor "${provedorDoModelo}", ` +
    `e o endereço da chamada é "${provedorDaChamada}" — enviá-lo assim seria entregar ` +
    `um id que aquele provedor não conhece`
  );
}

/**
 * ═══ A METADE QUE RESOLVE: DE ONDE SAI O PAR QUANDO NINGUÉM ESCOLHEU ════════
 *
 * A régua acima RECUSA o par cruzado na hora de executar. Faltava a metade de
 * quem ESCOLHE, e a falta dela deixou o defeito vivo no último call site da
 * issue #2377: `POST /api/v1/ai/agents` com corpo legado e sem `model` injetava
 * `anthropic/claude-sonnet-5` FIXO (`app/api/v1/ai/agents/route.ts`). Numa
 * instalação cujo provedor efetivo é OpenAI (ou OpenRouter, ou Google), o
 * agente nascia com um id que aquele endereço não executa: o par cruzado
 * nascia na ESCRITA, ficava gravado em `ai_agent_versions` e só aparecia no
 * turno — no caminho especializado, longe da tela que mostra o provedor geral.
 *
 * A ordem da resolução, do mais forte ao mais fraco (a mesma doutrina de
 * `lib/ai/pontos/resolver.ts`, aplicada ao par):
 *
 *  1. **O que veio no corpo** (`informado`) é escolha, não default: vale a rota
 *     do id (`openai/gpt-5-mini` executa na OpenAI mesmo com a organização em
 *     Anthropic). Id BARE vale sob o provedor do ENDEREÇO — e se o nome for de
 *     outra família (`claude-…` num endereço OpenAI), a resposta é RECUSA,
 *     nunca um provedor inventado para o id caber.
 *  2. **O padrão da organização** (`organizations.settings.llm`): provider e
 *     `default_model` JUNTOS, como o gatilho os semeia e o onboarding os grava.
 *     O par que não se sustenta (`{provider: 'openai', default_model:
 *     'claude-sonnet-5'}`, das instalações em que o instalador antigo trocou só
 *     o provedor) NÃO é usado — ele É o defeito que a issue descreve.
 *  3. **A compatibilidade explícita do provedor**
 *     (`MODELOS_DE_COMPATIBILIDADE`: hoje só a Anthropic, o padrão histórico do
 *     produto). O legado continua valendo, mas POR PROVEDOR — e nunca
 *     atravessando para o endereço de outro.
 *  4. **O catálogo do provedor efetivo** (`ai_models`, pela mesma régua da
 *     publicação do primeiro atendente), que quem chama lê e entrega.
 *
 * Nenhum degrau inventa id: sem par sustentável, a resposta é `ok: false` com o
 * motivo, e quem escreve recusa a operação com erro claro em vez de gravar um
 * modelo que o endereço configurado não executa (issue #2377, critério 2).
 */

/** O provedor do produto quando nem a organização nem o legado disseram nada. */
export const PROVEDOR_DE_COMPATIBILIDADE = "anthropic";

/**
 * A lista EXPLÍCITA do legado, por provedor — não um default solto.
 *
 * `claude-sonnet-5` foi o default do "Modo A" da API (`route.ts`), escrito à
 * mão no corpo legado. Ele continua valendo para uma instalação em Anthropic
 * (é o que a coluna do agente sempre recebeu), mas passa a valer POR PROVEDOR:
 * quem não é a Anthropic não o executa, e não há como isto atravessar para o
 * endereço de outro fabricante sem cair no degrau 4 ou na recusa.
 */
export const MODELOS_DE_COMPATIBILIDADE: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-5",
};

/** De onde saiu o par efetivo — vai para o log estruturado. */
export type OrigemDoParEfetivo =
  | "informado"
  | "padrao_da_organizacao"
  | "compatibilidade_do_provedor"
  | "catalogo_do_provedor";

/** `organizations.settings.llm`, como o painel e o onboarding o gravam. */
export interface LlmDaOrganizacao {
  provider?: unknown;
  default_model?: unknown;
}

export interface PedidoDoParEfetivo {
  /** O `model` que veio no corpo (`provedor/modelo` no formato legado). */
  modeloInformado?: string | null | undefined;
  /** O `settings.llm` da organização — lido por quem chama (I/O fora daqui). */
  llmDaOrganizacao?: LlmDaOrganizacao | null | undefined;
  /**
   * O modelo do catálogo (`ai_models`) do provedor efetivo. Vem como FUNÇÃO de
   * propósito: só é lido quando o padrão da organização não se sustenta, e essa
   * decisão é do degrau 4 — não de quem chama ter de adivinhar o provedor certo
   * antes de a resolução acontecer.
   */
  lerModeloDoCatalogo?: ((provider: string) => Promise<string | null>) | undefined;
}

export type ResultadoDoParEfetivo =
  | { ok: true; provider: string; model: string; origem: OrigemDoParEfetivo }
  | { ok: false; provider: string; model: string; motivo: string };

/** A rota do id quando ela nomeia um provedor que o produto conhece. */
function provedorDaRota(id: string): string | null {
  const corte = id.indexOf("/");
  if (corte <= 0) return null;
  const rotulo = id.slice(0, corte).toLowerCase();
  return PROVEDORES_DIRETOS.has(rotulo) || AGREGADORES.has(rotulo) ? rotulo : null;
}

/** O par (endereço, modelo) de um id: a rota manda; sem rota, o endereço manda. */
function parDoId(id: string, provedorDoEndereco: string): { provider: string; model: string } {
  const nome = id.trim();
  const rota = provedorDaRota(nome);
  if (rota !== null) return { provider: rota, model: nome.slice(nome.indexOf("/") + 1) };
  return { provider: provedorDoEndereco, model: nome };
}

/**
 * O par de um id GRAVADO como padrão da organização.
 *
 * No agregador o `/` faz parte do id (`anthropic/claude-sonnet-5` executado pela
 * OpenRouter): recortá-lo ali trocaria o provedor da empresa pelo fabricante do
 * modelo — o cruzamento que esta metade existe para impedir. Nos provedores
 * diretos, o prefixo do próprio provedor é enfeite e sai.
 */
function parDoPadrao(provider: string, gravado: string): { provider: string; model: string } {
  if (AGREGADORES.has(provider)) return { provider, model: gravado };
  const prefixo = `${provider}/`;
  return { provider, model: gravado.startsWith(prefixo) ? gravado.slice(prefixo.length) : gravado };
}

/**
 * Resolve o par (provedor, modelo) EFETIVO de quem não escolheu — issue #2377.
 *
 * Nunca lança: a recusa é `ok: false` com o motivo em PT-BR, para o chamador
 * responder como a porta dele deve (a API de agentes recusa a criação com 422).
 */
export async function resolverParEfetivo(
  pedido: PedidoDoParEfetivo,
): Promise<ResultadoDoParEfetivo> {
  const informado = String(pedido.modeloInformado ?? "").trim();
  const daOrganizacao = String(pedido.llmDaOrganizacao?.provider ?? "")
    .trim()
    .toLowerCase();
  const gravado = String(pedido.llmDaOrganizacao?.default_model ?? "").trim();
  const provedorDoEndereco = daOrganizacao === "" ? PROVEDOR_DE_COMPATIBILIDADE : daOrganizacao;

  // 1 · O que veio no corpo é ESCOLHA: vale a rota do id, e o par é conferido.
  if (informado !== "") {
    const par = parDoId(informado, provedorDoEndereco);
    const conferencia = validarParProvedorModelo(par.provider, par.model);
    if (!conferencia.valido) {
      return { ok: false, provider: par.provider, model: par.model, motivo: conferencia.motivo };
    }
    return { ok: true, provider: par.provider, model: par.model, origem: "informado" };
  }

  // 2 · O padrão da organização, quando ele se sustenta.
  if (gravado !== "") {
    const par = parDoPadrao(provedorDoEndereco, gravado);
    if (validarParProvedorModelo(par.provider, par.model).valido) {
      return { ok: true, provider: par.provider, model: par.model, origem: "padrao_da_organizacao" };
    }
  }

  // 3 · A compatibilidade explícita DESTE provedor (o legado Anthropic).
  const compatibilidade = MODELOS_DE_COMPATIBILIDADE[provedorDoEndereco];
  if (
    compatibilidade !== undefined &&
    validarParProvedorModelo(provedorDoEndereco, compatibilidade).valido
  ) {
    return {
      ok: true,
      provider: provedorDoEndereco,
      model: compatibilidade,
      origem: "compatibilidade_do_provedor",
    };
  }

  // 4 · O catálogo do provedor efetivo — a régua da publicação do atendente.
  const doCatalogo = (await pedido.lerModeloDoCatalogo?.(provedorDoEndereco)) ?? "";
  if (String(doCatalogo).trim() !== "") {
    const par = parDoPadrao(provedorDoEndereco, String(doCatalogo).trim());
    if (validarParProvedorModelo(par.provider, par.model).valido) {
      return { ok: true, provider: par.provider, model: par.model, origem: "catalogo_do_provedor" };
    }
  }

  return {
    ok: false,
    provider: provedorDoEndereco,
    model: "",
    motivo:
      `esta instalação está no provedor "${provedorDoEndereco}"` +
      (gravado === "" ? "" : ` e o modelo padrão gravado ("${gravado}") não é dele`) +
      " — não há modelo deste provedor para gravar. Escolha o modelo em Agente de IA › Provedores",
  };
}

/** Lançado por TODOS os caminhos de execução, sempre ANTES da chamada externa. */
export class ParProvedorModeloInvalidoError extends Error {
  readonly code = "par_provedor_modelo_invalido";
  override readonly name = "ParProvedorModeloInvalidoError";
  constructor(
    readonly provider: string,
    readonly model: string,
    motivo: string,
    readonly purpose?: string,
  ) {
    super(
      `Par provedor/modelo inválido${purpose ? ` no ponto "${purpose}"` : ""}: ${motivo}. ` +
        `Corrija o modelo deste ponto em Agente de IA → Provedores ` +
        `(o par tem de ser do mesmo provedor). Nenhuma chamada foi feita.`,
    );
  }
}

interface Logador {
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
}

export interface RegistroDaResolucao {
  organization_id?: string | undefined;
  /** O ponto de IA (`sentiment_classify`, `agent_turn`, …). */
  purpose: string;
  provider: string;
  model: string;
  /** De onde veio a escolha: `binding`, `credencial_da_organizacao`, `padrao`, … */
  origem: string;
  /** Só quando o par foi recusado: o porquê, em PT-BR. */
  motivo?: string | undefined;
}

/**
 * O log estruturado da execução: provedor, modelo, propósito e origem da
 * configuração em TODA resolução — é o que permite a tela e o operador dizerem
 * qual modelo efetivamente rodou em cada finalidade.
 *
 * Vaza só isto: nunca chave, prompt, telefone ou conteúdo de conversa.
 */
export function logarResolucaoDeModelo(log: Logador, registro: RegistroDaResolucao): void {
  const campos: Record<string, unknown> = {
    purpose: registro.purpose,
    provider: registro.provider,
    model: registro.model,
    origem_da_configuracao: registro.origem,
    ...(registro.organization_id ? { organization_id: registro.organization_id } : {}),
    ...(registro.motivo ? { motivo: registro.motivo } : {}),
  };
  if (registro.motivo) log.warn("ia: par provedor+modelo recusado antes da chamada", campos);
  else log.info("ia: par provedor+modelo validado", campos);
}

/** O logger da pilha antiga (`lib/logger`) e o do seam (`obs/logger`) servem aqui. */
export const logadorPadrao: Logador = logger;
