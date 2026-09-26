/**
 * AS TAREFAS DO JEV — o que ele faz, e em que estado cada coisa está.
 *
 * Uma tarefa não é um ponto de IA. Ponto (`lib/ai/pontos/registro.ts`) é onde
 * um modelo de linguagem é chamado; tarefa é uma pergunta que o Jev responde.
 * O clima mora num ponto, mas uma tarefa pode não ter ponto nenhum (uma regra
 * sem IA que o Jev só observa). O cartão, a rota e o "Usada em" da chave derivam
 * DESTA lista, nunca de uma cópia à mão.
 *
 * ═══ O ESTADO EFETIVO, NESTA ORDEM ═══
 *
 *  1. Interruptor mestre desligado (ou sem aceite) ⇒ desligada.
 *  2. A tarefa pede mais do que o aceite cobre (alcance) ⇒ desligada. Falha
 *     FECHADA: o aceite é o que a empresa consentiu mandar para fora do país.
 *  3. Estado gravado para a tarefa ⇒ ele. Gravado e ilegível já chega aqui
 *     como `desligada` (`./config.ts`): ilegível nunca é "ninguém escolheu".
 *  4. O clima sem estado gravado ⇒ o `modo` da onda 1.
 *  5. Tarefa nova, sem estado gravado, que cabe no aceite de "cada mensagem,
 *     sozinha" ⇒ observando (DEC-012 #3): observar não muda nada para o
 *     cliente e usa o dado já aceito. Uma que pede a conversa nunca começa
 *     sozinha.
 */
import type { CamadaSemantica } from "@/lib/agent-engine/guardrails/camadas-da-org";

import {
  ALCANCES,
  ESTADO_DO_MODO,
  type Alcance,
  type ConfigDoJev,
  type EstadoDaTarefa,
  type IdDaTarefa,
  type TarefaGravada,
} from "./config";

interface ComumDaTarefa {
  id: IdDaTarefa;
  /** A pergunta que o Jev responde — com ponto, a mesma do `decisaoRapida` dele. */
  primitiva: "score" | "choice" | "noul";
  /** O que sai para o fornecedor. Maior que o aceite ⇒ desligada. */
  alcance: Alcance;
  /**
   * O que muda quando ela DECIDE, dito ao leigo no cartão do Jev. É por tarefa,
   * e não pela família: o clima e o roteador são os dois `substitui`, e a IA de
   * sempre é chamada só quando o Jev falha num, e a cada mensagem no outro. Uma
   * frase por família fez o roteador herdar a do clima.
   */
  aoDecidir: string;
  /**
   * O que o diálogo de "Deixar o Jev decidir" diz ANTES do clique valer: o
   * efeito concreto em produção, na língua de quem não é engenheiro. Um clique
   * sem explicação mudava o atendimento de todas as mensagens seguintes.
   */
  aoConfirmarDecidir: string;
  /**
   * A camada de segurança que ela ACOMPANHA, quando há uma: desligada para a
   * organização, o turno não pergunta nem à IA de sempre nem ao Jev, e a tarefa
   * não roda qualquer que seja o estado dela (`tarefaSemCamada`).
   */
  camada?: CamadaSemantica;
  /**
   * Para quem não é engenheiro: vão à tela por `t()`. O `rotulo` é o nome do que
   * o JEV faz, e pode diferir do nome do ponto; com ponto, o `oQueFaz` é o
   * `oQueOJevFaz` do registro, igual.
   */
  rotulo: string;
  oQueFaz: string;
}

/**
 * Onde ela mora. Com ponto (`lib/ai/pontos/registro.ts`), o cartão do ponto
 * fala dela sobre o modelo que mostra logo abaixo (`aoDecidirNoPonto`). Sem
 * ponto — uma regra sem IA que o Jev só acompanha —, não há cartão de ponto nem
 * modelo para citar, e a frase não existe.
 */
type OndeMora = { ponto: string; aoDecidirNoPonto: string } | { ponto?: undefined; aoDecidirNoPonto?: undefined };

/**
 * Como ela convive com o que já existe, e o que o cartão mostra enquanto ela
 * observa:
 *
 *  - `substitui` (o Jev pode decidir no lugar do mecanismo de hoje), `soma`
 *    (decidindo, o sinal dele se SOMA ao do mecanismo de hoje e nunca o apaga)
 *    e `novo` (não há mecanismo hoje): a CONCORDÂNCIA, antes e depois do "X de
 *    Y" — diz EM QUE os dois concordaram. Sem ela, a manipulação e o roteador
 *    liam "o Jev concordou com a sua IA de sempre", e o leigo não sabia no quê.
 *  - `cascata`: o Jev só é perguntado onde a regra de hoje disse NÃO. Não há o
 *    que concordar — a regra, por construção, sempre disse não —, e o cartão
 *    mostra quantos pedidos ele PERCEBEU que ela deixou passar (`percebidos`,
 *    o fim da frase depois do "N pedidos").
 */
type ComoConvive =
  | {
      familia: "substitui" | "soma" | "novo";
      concordancia: { antes: string; depois: string };
      percebidos?: undefined;
    }
  | { familia: "cascata"; percebidos: string; concordancia?: undefined };

export type TarefaDoJev = ComumDaTarefa & OndeMora & ComoConvive;

/**
 * O clima: a única tarefa da onda 1, e a única cujo estado também se chama
 * `modo` (ver `./config.ts`). Os textos são os do ponto `sentiment_classify`.
 */
export const TAREFA_DO_CLIMA = {
  id: "clima",
  ponto: "sentiment_classify",
  primitiva: "score",
  alcance: "mensagem",
  familia: "substitui",
  // A IA de sempre só é chamada quando o Jev falha (`workers/ai-sentiment-worker.ts`).
  aoDecidir: "O Jev mede primeiro; a sua IA de sempre só entra se ele não responder.",
  aoDecidirNoPonto: "O Jev mede primeiro; o modelo abaixo é a reserva.",
  aoConfirmarDecidir:
    "A partir de agora é o Jev que percebe o cliente irritado e chama uma pessoa; a sua IA de sempre só entra se ele falhar.",
  // A régua do clima é o corte da passagem para humano (`app/api/v1/ai/jev/route.ts`).
  concordancia: {
    antes: "dias, o Jev e a sua IA de sempre chegaram à mesma conclusão em",
    depois: "mensagens — os dois chamariam, ou não, uma pessoa para a conversa.",
  },
  rotulo: "Medir o clima da conversa",
  oQueFaz:
    "Percebe, geralmente em menos de um segundo, se o cliente está irritado — e avisa para passar a conversa a uma pessoa.",
} as const satisfies TarefaDoJev;

/**
 * A manipulação (`./manipulacao.ts`): a mesma pergunta do classificador
 * anti-manipulação do turno, com os mesmos três níveis. É `soma`, e não
 * `substitui`: o classificador de hoje é advisório e nunca veta, e o Jev
 * decidindo só pode ACRESCENTAR sinal ao dele — o maior dos dois vale, e sem a
 * IA de sempre vale "nenhum sinal", como hoje (R2).
 */
export const TAREFA_DA_MANIPULACAO = {
  id: "manipulacao",
  ponto: "jailbreak_detect",
  primitiva: "choice",
  alcance: "mensagem",
  familia: "soma",
  // Sem "a sua IA segue decidindo" ao lado do selo "Decide": o verbo era o
  // mesmo para os dois, e o leigo não sabia o que tinha ligado.
  aoDecidir:
    "O alerta do Jev passa a contar junto com o da sua IA de sempre: vale o mais forte dos dois, e o Jev nunca apaga o dela.",
  aoDecidirNoPonto: "O modelo abaixo decide; o Jev soma o sinal dele, sem nunca apagar o do modelo.",
  aoConfirmarDecidir: "O alerta do Jev passa a somar ao da sua IA — ele nunca apaga um alerta dela.",
  // A régua é o nível exato (nenhum, leve, forte) — e o cartão mostra junto
  // quantas vezes só o Jev daria o forte, que é o que decidir muda.
  concordancia: {
    antes: "dias, o Jev e a sua IA de sempre deram o mesmo alerta (nenhum, leve ou forte) em",
    depois: "mensagens.",
  },
  camada: "jailbreak",
  // O nome do ponto ("Barrar…") é o do classificador; o Jev não barra nada —
  // percebe e soma o sinal. Dizer "barrar" ao leigo prometeria um bloqueio.
  rotulo: "Perceber tentativa de manipulação",
  oQueFaz:
    "Percebe, na mensagem do cliente, quem tenta enganar o agente para ele fugir das suas regras — e soma esse sinal ao da sua IA de sempre, sem nunca apagá-lo.",
} as const satisfies TarefaDoJev;

/**
 * O roteador (`./roteador.ts`): qual agente atende, entre os membros do
 * roteador de intenção do número. É `substitui`: decidindo, a escolha dele
 * toma o lugar da do classificador de sempre, que vira a reserva — e sem ele
 * vale o que vale hoje (o agente de antes, ou o de reserva do roteador),
 * nunca o Jev (R2). Só roda onde há um roteador ativo: sem ele o turno não
 * classifica nada (`tarefaSemRoteador`).
 */
export const TAREFA_DO_ROTEADOR = {
  id: "roteador",
  ponto: "intent_router",
  primitiva: "choice",
  alcance: "mensagem",
  familia: "substitui",
  // Os dois perguntam a cada mensagem (`resolve-turn-agent.ts`), e sem a
  // resposta da IA de sempre a do Jev não vale (R2) — ao contrário do clima.
  // "Agente de fallback" é o nome do campo na tela do roteador: "o de reserva
  // do roteador" não levava o leigo ao campo que ele precisa conferir.
  aoDecidir:
    "A sua IA de sempre continua sendo perguntada a cada mensagem, ao mesmo tempo que o Jev, e continua custando: vale a escolha do Jev, e a dela entra quando ele não responde. Sem a resposta da sua IA de sempre, vale o agente de antes ou o “Agente de fallback” do roteador — nunca só o Jev.",
  aoDecidirNoPonto:
    "Vale a escolha do Jev, mas o modelo abaixo continua sendo chamado a cada mensagem: é a reserva quando o Jev não responde, e sem ele o Jev não escolhe sozinho.",
  aoConfirmarDecidir:
    "É o Jev que escolhe o agente de cada mensagem; a sua IA de sempre continua sendo perguntada ao mesmo tempo e assume se ele falhar.",
  // A régua é o MESMO AGENTE FINAL (`./roteador.ts`), não a mesma intenção.
  concordancia: {
    antes: "dias, o Jev e a sua IA de sempre levariam o cliente ao mesmo agente em",
    depois: "mensagens.",
  },
  rotulo: "Escolher qual agente atende",
  oQueFaz:
    "Lê a última mensagem do cliente, sozinha, e escolhe entre as intenções do seu roteador qual agente deve atender.",
} as const satisfies TarefaDoJev;

/**
 * O pedido para falar com uma pessoa (`./pedidos.ts`). A regra de hoje é a do
 * turno do agente: a detecção de pedido explícito e as palavras de passagem que
 * o agente tem configuradas. É `cascata`: o Jev só é perguntado onde ela disse
 * não, e nunca passa a conversa — quem passa é a regra, ou uma pessoa.
 */
export const TAREFA_DO_PEDIDO_DE_HUMANO = {
  id: "humano",
  primitiva: "noul",
  alcance: "mensagem",
  familia: "cascata",
  aoDecidir:
    "Quando o Jev percebe um pedido para falar com uma pessoa que a regra não pegou, ele abre um aviso na Central para alguém da equipe decidir. Ele nunca passa a conversa sozinho.",
  aoConfirmarDecidir:
    "Quando o Jev perceber um pedido para falar com uma pessoa que a regra não pegou, ele abre um aviso na Central para alguém da equipe decidir. Ele nunca passa a conversa sozinho.",
  percebidos: "de falar com uma pessoa que a regra de hoje não pegou.",
  rotulo: "Perceber pedido para falar com uma pessoa",
  oQueFaz:
    "Lê a mensagem do cliente, sozinha, quando a regra de hoje não viu nela um pedido para falar com uma pessoa — e conta os pedidos que ela deixou passar. Ele nunca passa a conversa sozinho.",
} as const satisfies TarefaDoJev;

/**
 * O pedido para parar de receber mensagens (`./pedidos.ts`). A regra de hoje é
 * `lib/opt-out/deteccao.ts` — a que bloqueia, na entrada da mensagem, e a que o
 * turno usa para parar de responder. `cascata`: o Jev só é perguntado onde ela
 * disse não, e nunca bloqueia ninguém.
 */
export const TAREFA_DO_PEDIDO_PARA_PARAR = {
  id: "opt_out",
  primitiva: "noul",
  alcance: "mensagem",
  familia: "cascata",
  aoDecidir:
    "Quando o Jev percebe um pedido para parar de receber mensagens que a regra não pegou, ele abre um aviso na Central. Quem bloqueia continua sendo a regra de hoje ou uma pessoa: o Jev nunca bloqueia ninguém.",
  aoConfirmarDecidir:
    "Quando o Jev perceber um pedido para parar de receber mensagens que a regra não pegou, ele abre um aviso na Central. Quem bloqueia continua sendo a regra de hoje ou uma pessoa: o Jev nunca bloqueia ninguém.",
  percebidos: "para parar de receber mensagens que a regra de hoje não pegou.",
  rotulo: "Perceber pedido para parar de receber mensagens",
  oQueFaz:
    "Lê a mensagem do cliente, sozinha, quando a regra de hoje não viu nela um pedido para parar de receber mensagens — e conta os pedidos que ela deixou passar. Quem bloqueia continua sendo a regra de hoje ou uma pessoa.",
} as const satisfies TarefaDoJev;

export const TAREFAS_DO_JEV: readonly TarefaDoJev[] = [
  TAREFA_DO_CLIMA,
  TAREFA_DA_MANIPULACAO,
  TAREFA_DO_ROTEADOR,
  TAREFA_DO_PEDIDO_DE_HUMANO,
  TAREFA_DO_PEDIDO_PARA_PARAR,
];

/**
 * A tarefa pode ser posta decidindo NESTA versão? A em cascata ainda não: o
 * aviso na Central que o `aoDecidir` dela descreve ainda não existe, e decidir
 * não pode prometer o que não acontece. Até ele existir, nem o cartão oferece o
 * botão nem a rota aceita o pedido (`app/api/v1/ai/jev/route.ts`).
 */
export function tarefaPodeDecidir(tarefa: Pick<TarefaDoJev, "familia">): boolean {
  return tarefa.familia !== "cascata";
}

/**
 * A chamada que pergunta os dois pedidos (`./pedidos.ts`) precisa de um
 * `purpose` na linha dela em `llm_calls`. Não é um ponto do registro: não há IA
 * de sempre para escolher ali — a regra de hoje não usa modelo —, e um ponto
 * sem chamador seria botão que não controla nada na tela de provedores. Quem
 * dá nome de gente a ela em IA › Execuções e na "Última falha" do cartão é
 * `rotuloDaChamadaDoJev`.
 */
export const PEDIDOS_DO_CLIENTE = { purpose: "jev_pedidos", rotulo: "Perceber pedidos do cliente" } as const;

/**
 * O nome de gente da chamada do Jev com este `purpose`: o da tarefa daquele
 * ponto, ou o dos pedidos. `null` quando não é chamada do Jev.
 */
export function rotuloDaChamadaDoJev(purpose: string): string | null {
  if (purpose === PEDIDOS_DO_CLIENTE.purpose) return PEDIDOS_DO_CLIENTE.rotulo;
  return TAREFAS_DO_JEV.find((t) => t.ponto === purpose)?.rotulo ?? null;
}

/**
 * O estado que a EMPRESA escolheu para a tarefa, sem olhar o interruptor nem o
 * aceite. `undefined` = ninguém escolheu ainda (tarefa nova).
 */
export function estadoGravadoDaTarefa(config: ConfigDoJev, id: string): EstadoDaTarefa | undefined {
  const gravadas: Partial<Record<string, TarefaGravada>> = config.tarefas ?? {};
  const gravada = gravadas[id];
  if (gravada !== undefined) return gravada.estado;
  if (id === TAREFA_DO_CLIMA.id) return ESTADO_DO_MODO[config.modo];
  return undefined;
}

/**
 * Só o que a regra lê de uma tarefa. O `id` é `string` para a regra valer
 * também para a tarefa que ainda não existe — é assim que o teste prova o
 * item 5 antes de haver uma segunda tarefa.
 */
type TarefaNaRegra = Pick<TarefaDoJev, "alcance"> & { id: string };

/** Itens 2 a 5 do cabeçalho, com o Jev ligado sob o aceite `aceito`. */
function estadoSobOAceite(config: ConfigDoJev, tarefa: TarefaNaRegra, aceito: Alcance): EstadoDaTarefa {
  if (ALCANCES.indexOf(tarefa.alcance) > ALCANCES.indexOf(aceito)) return "desligada";
  return (
    estadoGravadoDaTarefa(config, tarefa.id) ?? (tarefa.alcance === "mensagem" ? "observando" : "desligada")
  );
}

/** O estado que vale agora — ver o cabeçalho. */
export function estadoEfetivoDaTarefa(config: ConfigDoJev, tarefa: TarefaNaRegra): EstadoDaTarefa {
  if (!config.ligado || config.aceite === null) return "desligada";
  return estadoSobOAceite(config, tarefa, config.aceite.alcance ?? "mensagem");
}

/**
 * O estado em que a tarefa fica se o Jev for ligado AGORA — o que o "pronto
 * para ligar" promete. Sem aceite ainda, vale o que a tela pede: cada
 * mensagem, sozinha (`app/api/v1/ai/jev/route.ts`, ao ligar).
 */
export function estadoAoLigar(config: ConfigDoJev, tarefa: TarefaNaRegra): EstadoDaTarefa {
  return estadoSobOAceite(config, tarefa, config.aceite?.alcance ?? "mensagem");
}

/** Começou sozinha e ninguém escolheu nada ainda: é o selo "Novo" do cartão. */
export function tarefaEhNova(config: ConfigDoJev, tarefa: TarefaNaRegra): boolean {
  return estadoGravadoDaTarefa(config, tarefa.id) === undefined && estadoEfetivoDaTarefa(config, tarefa) !== "desligada";
}

/**
 * A tarefa acompanha uma camada que está desligada para a organização? Então ela
 * não roda: o turno só pergunta ao Jev onde a IA de sempre também pergunta
 * (`lib/agent-engine/agent/inbound-turn.ts`). `camadas` é o efetivo da
 * organização (`camadasEfetivas`).
 */
export function tarefaSemCamada(
  tarefa: TarefaDoJev,
  camadas: Readonly<Record<CamadaSemantica, boolean>>,
): boolean {
  return tarefa.camada !== undefined && !camadas[tarefa.camada];
}

/** O fornecedor aceita até 255 opções numa escolha, e uma delas é "nenhuma". */
export const MEMBROS_NO_MAXIMO = 254;

/**
 * Um roteador com esta quantidade de intenções pode ser perguntado ao Jev? Sem
 * nenhuma, ou com mais do que cabe numa escolha, a pergunta não sai
 * (`perguntaDoRoteador`, `./roteador.ts`).
 */
export function roteadorCabeNaPergunta(intencoes: number): boolean {
  return intencoes >= 1 && intencoes <= MEMBROS_NO_MAXIMO;
}

/**
 * Das linhas de `ai_routers` ativos lidas com `intencoes:ai_router_members(count)`
 * (o PostgREST devolve `[{ count }]`), alguma pode ser perguntada ao Jev?
 */
export function algumRoteadorQuePergunta(roteadores: ReadonlyArray<{ intencoes?: unknown }>): boolean {
  return roteadores.some((r) => {
    const [contagem] = Array.isArray(r.intencoes) ? (r.intencoes as Array<{ count?: unknown }>) : [];
    return typeof contagem?.count === "number" && roteadorCabeNaPergunta(contagem.count);
  });
}

/**
 * A tarefa do roteador numa organização sem um roteador de intenção ativo que o
 * Jev possa perguntar: o turno não escolhe agente (ou o Jev nunca é perguntado,
 * com o roteador sem intenções ou com mais do que cabe), e "observando"
 * prometeria uma comparação que nunca vem. `temRoteadorQuePergunta` é lido por
 * quem chama: algum `ai_routers.is_active` com `roteadorCabeNaPergunta`.
 * ponytail: vale "algum" roteador da organização, e o turno usa o do número; a
 * organização com um roteador bom e outro vazio vê a tarefa rodando.
 */
export function tarefaSemRoteador(tarefa: Pick<TarefaDoJev, "id">, temRoteadorQuePergunta: boolean): boolean {
  return tarefa.id === TAREFA_DO_ROTEADOR.id && !temRoteadorQuePergunta;
}
