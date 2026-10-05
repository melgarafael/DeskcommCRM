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
 *     Na tarefa que só observa (`soObserva`), um `decidindo` gravado vale
 *     `observando`: é o que o worker desta versão faz com ele.
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

/** A tarefa que pode decidir — e o que decidir muda nela. */
interface PodeDecidir {
  /**
   * O que muda quando ela DECIDE, dito ao leigo no cartão do Jev. É por tarefa,
   * e não pela família: o clima e o roteador são os dois `substitui`, e a IA de
   * sempre é chamada só quando o Jev falha num, e a cada mensagem no outro. Uma
   * frase por família fez o roteador herdar a do clima.
   */
  aoDecidir: string;
  /**
   * O que o diálogo de "Deixar o Jev decidir" (na cascata, "Avisar a equipe")
   * diz ANTES do clique valer: o efeito concreto em produção, na língua de quem
   * não é engenheiro. Um clique sem explicação mudava o atendimento de todas as
   * mensagens seguintes.
   */
  aoConfirmarDecidir: string;
  soObserva?: undefined;
}

/**
 * A tarefa que, nesta versão, SÓ OBSERVA: o cartão não oferece "Deixar o Jev
 * decidir", a rota recusa `decidindo` (`jev_tarefa_so_observa`) e o estado
 * efetivo nunca é `decidindo` (`estadoEfetivoDaTarefa`). `soObserva` é o
 * porquê, dito ao leigo no cartão e na recusa da rota. Sem frase de decidir:
 * uma frase que ninguém pode ver é frase que ninguém confere.
 */
interface SoObserva {
  ponto: string;
  soObserva: string;
  aoDecidir?: undefined;
  aoConfirmarDecidir?: undefined;
  aoDecidirNoPonto?: undefined;
}

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
 *    mostra em quantas MENSAGENS ele percebeu o pedido que ela não reconheceu
 *    (`percebidos`: a frase INTEIRA, para nenhuma, uma e várias, com `{dias}` e
 *    `{n}` — frase montada de pedaços traduzidos sai torta em outro idioma). A
 *    unidade é a mensagem, e não o pedido: o worker pergunta no
 *    `message.received`, antes da janela do turno, e a rajada com duas frases
 *    naturais conta duas (ver `app/api/v1/ai/jev/route.ts`). O estado
 *    `decidindo` dela se chama "Avisar a equipe" na tela: o que ele faz é abrir
 *    um aviso na Central (`./pedidos.ts`), nunca agir no lugar da regra.
 */
type ComoConvive =
  | {
      familia: "substitui" | "soma" | "novo";
      concordancia: { antes: string; depois: string };
      percebidos?: undefined;
    }
  | { familia: "cascata"; percebidos: { nenhuma: string; uma: string; varias: string }; concordancia?: undefined };

export type TarefaDoJev = ComumDaTarefa & ((PodeDecidir & OndeMora) | SoObserva) & ComoConvive;

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
export const ROTEADOR_SOB_DEMANDA = "O Jev escolhe primeiro. A IA de sempre só entra em caso de falha, baixa confiança ou intenção inválida.";
/**
 * Por que o Jev não roteia sozinho nesta empresa (decisão B do doc 89, R2 do
 * DEC-012): a mesma frase na recusa do PATCH e no cartão.
 */
export const ROTEADOR_SOB_DEMANDA_SEM_IA =
  "Sem a sua IA de sempre, o Jev não escolhe o agente sozinho: é ela que cobre quando ele falha ou fica em dúvida. Cadastre uma chave de IA em Agentes IA › Credenciais para usar este modo. Até lá, vale a comparação.";

export const TAREFA_DO_ROTEADOR = {
  id: "roteador",
  ponto: "intent_router",
  primitiva: "choice",
  alcance: "mensagem",
  familia: "substitui",
  // Texto do modo comparação. Sob demanda, a tela usa ROTEADOR_SOB_DEMANDA.
  // Na comparação, os dois perguntam a cada mensagem, e sem a
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
  percebidos: {
    nenhuma:
      "Nos últimos {dias} dias, o Jev ainda não percebeu nenhuma mensagem pedindo para falar com uma pessoa em que a regra de hoje não reconheceu o pedido.",
    uma: "Nos últimos {dias} dias, o Jev percebeu {n} mensagem pedindo para falar com uma pessoa em que a regra de hoje não reconheceu o pedido.",
    varias:
      "Nos últimos {dias} dias, o Jev percebeu {n} mensagens pedindo para falar com uma pessoa em que a regra de hoje não reconheceu o pedido.",
  },
  rotulo: "Perceber pedido para falar com uma pessoa",
  oQueFaz:
    "Lê a mensagem do cliente, sozinha, quando a regra de hoje não viu nela um pedido para falar com uma pessoa — e conta as mensagens com esse pedido que ela não reconheceu. Ele nunca passa a conversa sozinho.",
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
    "Quando o Jev percebe um pedido para parar de receber mensagens que a regra não pegou, ele abre um aviso na Central para alguém da equipe conferir. Quem bloqueia o contato é só a regra de hoje, quando o próprio cliente manda PARAR: o Jev nunca bloqueia ninguém.",
  aoConfirmarDecidir:
    "Quando o Jev perceber um pedido para parar de receber mensagens que a regra não pegou, ele abre um aviso na Central para alguém da equipe conferir. Quem bloqueia o contato é só a regra de hoje, quando o próprio cliente manda PARAR: o Jev nunca bloqueia ninguém.",
  percebidos: {
    nenhuma:
      "Nos últimos {dias} dias, o Jev ainda não percebeu nenhuma mensagem pedindo para parar de receber mensagens em que a regra de hoje não reconheceu o pedido.",
    uma: "Nos últimos {dias} dias, o Jev percebeu {n} mensagem pedindo para parar de receber mensagens em que a regra de hoje não reconheceu o pedido.",
    varias:
      "Nos últimos {dias} dias, o Jev percebeu {n} mensagens pedindo para parar de receber mensagens em que a regra de hoje não reconheceu o pedido.",
  },
  rotulo: "Perceber pedido para parar de receber mensagens",
  oQueFaz:
    "Lê a mensagem do cliente, sozinha, quando a regra de hoje não viu nela um pedido para parar de receber mensagens — e conta as mensagens com esse pedido que ela não reconheceu. Quem bloqueia o contato é só a regra de hoje, quando o próprio cliente manda PARAR.",
} as const satisfies TarefaDoJev;

/**
 * A resposta ao follow-up (`./followup.ts`): em qual das saídas do nó
 * "Classificar (IA)" do fluxo a resposta do cliente se encaixa — as classes que
 * a empresa criou, a mesma pergunta da IA de sempre (`followup_classify`). É
 * `substitui` porque é a única família que cabe: a classe é uma só (não há
 * sinal para SOMAR), a IA de sempre responde toda resposta (não há regra de
 * hoje que diga não antes, como na cascata) e já existe quem decide (não é
 * `novo`). Decidindo, a classe dele tomaria o lugar da dela — e é por isso que
 * nesta versão ela SÓ OBSERVA (`soObserva`): a classe move o cliente no fluxo,
 * e deixar o Jev movê-lo espera a concordância medida com respostas de verdade.
 * Só roda onde algum follow-up tem o passo, publicado ou com inscrição em
 * andamento (`tarefaSemFluxo`).
 */
export const TAREFA_DO_FOLLOWUP = {
  id: "followup",
  ponto: "followup_classify",
  primitiva: "choice",
  alcance: "mensagem",
  familia: "substitui",
  soObserva:
    "Nesta versão, o Jev só observa esta tarefa: quem escolhe a saída do fluxo é sempre a sua IA de sempre, e não há como deixar o Jev decidir. A saída escolhida muda o caminho do cliente no fluxo, então primeiro se mede, com respostas de verdade, o quanto os dois concordam.",
  // A régua é a MESMA SAÍDA: a classe dele contra a da IA de sempre, ao pé da letra.
  concordancia: {
    antes: "dias, o Jev e a sua IA de sempre puseram a resposta do cliente na mesma saída do fluxo em",
    // "mensagens", como no "Ainda não há mensagens medidas" do mesmo lugar: a
    // unidade não muda entre o cartão vazio e o com número.
    depois: "mensagens.",
  },
  rotulo: "Ler a resposta ao follow-up",
  oQueFaz:
    "Lê a resposta do cliente à mensagem do follow-up, sozinha, e diz em qual das saídas que você criou no fluxo ela se encaixa.",
} as const satisfies TarefaDoJev;

/**
 * A conferência de campo personalizado do negócio (#2234): antes de a IA gravar
 * um campo do funil na ficha, conferir nas mensagens do CLIENTE se foi ele quem
 * disse aquele valor. Hoje `crm_update_lead` grava `custom_fields` direto
 * (`lib/mcp/tools/leads.ts`), sem nenhuma conferência — os campos de CONTATO já
 * têm proposta com confirmação humana (#1650), os do negócio não, e uma
 * confirmação humana a cada valor seria pesada demais.
 *
 * É `novo`: não há mecanismo de conferência hoje com o que concordar. É
 * `alcance: "conversa"` de propósito: o degrau 2 lê as mensagens pendentes do
 * TURNO, em geral 1 a 3 juntas — mais que o aceite de "cada mensagem, sozinha",
 * então sem o aceite da conversa (`config.aceite.alcance`) ela nasce DESLIGADA
 * e a ficha segue gravando como hoje.
 *
 * O degrau 1 (número, data, e-mail e valor monetário conferidos em código, sem
 * rede) não depende do Jev: ele acontece antes, em quem chama (`./campo-do-negocio`).
 */
export const TAREFA_DA_CONFERENCIA_DE_CAMPO = {
  id: "campo_do_negocio",
  primitiva: "noul",
  alcance: "conversa",
  familia: "novo",
  aoDecidir:
    "O Jev confere, nas mensagens que o cliente deixou sem resposta neste turno, se foi ele quem disse o valor do campo. O valor que ele não disse deixa de ser gravado e o assistente é mandado perguntar para ele; os outros campos da mesma chamada seguem gravando.",
  aoConfirmarDecidir:
    "Antes de a IA gravar um campo personalizado do negócio, o Jev vai conferir nas mensagens do cliente se foi ele quem informou aquele valor. Ele não disse: o campo não é gravado e a IA pergunta ao cliente.",
  concordancia: {
    antes: "dias, o Jev e o jeito de hoje deram o mesmo destino a",
    depois: "campos do negócio.",
  },
  rotulo: "Conferir o campo antes de a IA gravar",
  oQueFaz:
    "Lê o que o cliente disse nas mensagens ainda sem resposta do turno e confere se o valor que a IA quer gravar no campo personalizado do negócio foi ele quem informou.",
} as const satisfies TarefaDoJev;

export const TAREFAS_DO_JEV: readonly TarefaDoJev[] = [
  TAREFA_DO_CLIMA,
  TAREFA_DA_MANIPULACAO,
  TAREFA_DO_ROTEADOR,
  TAREFA_DO_PEDIDO_DE_HUMANO,
  TAREFA_DO_PEDIDO_PARA_PARAR,
  TAREFA_DO_FOLLOWUP,
  TAREFA_DA_CONFERENCIA_DE_CAMPO,
];

/**
 * A tarefa pode deixar o Jev decidir (na cascata, avisar a equipe)? A que só
 * observa, não: o cartão não oferece o botão, e a rota recusa `decidindo`.
 */
export function tarefaPodeDecidir(tarefa: Pick<TarefaDoJev, "soObserva">): boolean {
  return tarefa.soObserva === undefined;
}

/**
 * A chamada da conferência de campo (#2234): também sem ponto no registro — o
 * degrau 2 do `crm_update_lead` é quem pergunta, e as perguntas são por CAMPO,
 * não por tarefa (`./campo-do-negocio`). Mesmo enquadramento de
 * `PEDIDOS_DO_CLIENTE`, incluindo o `porQue` como PERGUNTA: a chamada sai só
 * quando há campo para conferir, e a falha não muda nada no atendimento.
 */
export const CONFERENCIA_DE_CAMPO = {
  purpose: "jev_campo_do_negocio",
  rotulo: "Conferir o campo antes de a IA gravar",
  porQue:
    "O Jev foi perguntado se o cliente disse, nas mensagens ainda sem resposta deste turno, o valor do campo personalizado do negócio que a IA ia gravar.",
  porQueNaFalha: "O Jev não respondeu: o campo foi gravado como antes, sem a conferência.",
} as const;

/**
 * A chamada que pergunta os dois pedidos (`./pedidos.ts`) precisa de um
 * `purpose` na linha dela em `llm_calls`. Não é um ponto do registro: não há IA
 * de sempre para escolher ali — a regra de hoje não usa modelo —, e um ponto
 * sem chamador seria botão que não controla nada na tela de provedores. Quem
 * dá nome de gente a ela em IA › Execuções e na "Última falha" do cartão é
 * `rotuloDaChamadaDoJev`.
 *
 * O "por quê" da linha em Execuções também é dela (`porQue`, `porQueNaFalha`):
 * os textos de origem do Jev (`EXPLICACAO_DA_ORIGEM`, `JEV_FALHOU_AO_LADO`)
 * falam de decidir, comparar e da "IA de sempre" — e aqui ele não decide nada,
 * não há com o que comparar, e quem vale sem ele é a regra. O `porQue` é uma
 * PERGUNTA, e não uma afirmação sobre a mensagem: a chamada sai em quase toda
 * mensagem (não pode pressupor que houve pedido) e também quando a regra pegou
 * o OUTRO pedido ("quero falar com um atendente" é perguntado só sobre parar de
 * receber — não pode dizer que a regra não viu pedido nenhum).
 */
export const PEDIDOS_DO_CLIENTE = {
  purpose: "jev_pedidos",
  rotulo: "Perceber pedidos do cliente",
  porQue: "O Jev foi perguntado se esta mensagem traz um pedido que a regra de hoje não viu. Ele não bloqueia nem passa a conversa.",
  porQueNaFalha: "O Jev não respondeu: valeu só a regra de hoje.",
} as const;

/**
 * O nome de gente da chamada do Jev com este `purpose`: o da tarefa daquele
 * ponto, ou o dos pedidos. `null` quando não é chamada do Jev.
 */
export function rotuloDaChamadaDoJev(purpose: string): string | null {
  if (purpose === CONFERENCIA_DE_CAMPO.purpose) return CONFERENCIA_DE_CAMPO.rotulo;
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
type TarefaNaRegra = Pick<TarefaDoJev, "alcance"> & { id: string; soObserva?: string };

/** Itens 2 a 5 do cabeçalho, com o Jev ligado sob o aceite `aceito`. */
function estadoSobOAceite(config: ConfigDoJev, tarefa: TarefaNaRegra, aceito: Alcance): EstadoDaTarefa {
  if (ALCANCES.indexOf(tarefa.alcance) > ALCANCES.indexOf(aceito)) return "desligada";
  const gravado = estadoGravadoDaTarefa(config, tarefa.id);
  // Um `decidindo` que outra versão gravou (uma que deixe decidir, revertida)
  // vale aqui o que o worker DESTA faz com ele: observar. Sem isto o cartão
  // diria "Decide" numa tarefa em que ninguém lê a resposta do Jev.
  if (gravado === "decidindo" && tarefa.soObserva !== undefined) return "observando";
  return gravado ?? (tarefa.alcance === "mensagem" ? "observando" : "desligada");
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

/** O fornecedor aceita até 255 opções numa escolha — e na do follow-up não há "nenhuma". */
export const SAIDAS_NO_MAXIMO = 255;

/**
 * As saídas de um passo "Classificar (IA)" podem ser perguntadas ao Jev
 * (`perguntaDoFollowup`, `./followup.ts`)? De 2 a `SAIDAS_NO_MAXIMO`, nenhuma
 * em branco, nenhuma repetida. Com UMA saída não há escolha: a IA de sempre só
 * pode devolver ela, o Jev também, e cada resposta seria uma concordância paga
 * e vazia puxando o "X de Y" para 100%. Em branco ou repetida, a API recusaria
 * a chamada inteira, e a recusa abriria o disjuntor da tarefa sem ninguém ter
 * errado nada (a chave de um critério é o nome da saída — duas iguais seriam
 * uma só).
 */
export function saidasCabemNaPergunta(classes: readonly unknown[]): boolean {
  return (
    classes.length >= 2 &&
    classes.length <= SAIDAS_NO_MAXIMO &&
    classes.every((c) => typeof c === "string" && c.trim() !== "") &&
    new Set(classes).size === classes.length
  );
}

/**
 * Os status em que a inscrição já não anda (`followup_enrollments.status`), no
 * formato do filtro `in` do PostgREST. Fora deles, o motor ainda pode levá-la ao
 * passo "Classificar (IA)" da versão EM QUE ELA ESTÁ — que pode não ser a
 * publicada, nem estar num fluxo ativo: desativar um follow-up não encerra as
 * inscrições dele, e publicar outra versão não as muda de versão.
 */
export const INSCRICAO_ENCERRADA = "(completed,cancelled,dead)";

/**
 * Das versões lidas com o grafo (`{ versao: { graph } }`) — a ativa de cada
 * follow-up publicado, e a de cada inscrição que ainda anda (fora de
 * `INSCRICAO_ENCERRADA`) —, alguma tem o passo "Classificar (IA)" com saídas
 * que o Jev pode ser perguntado (`saidasCabemNaPergunta`)? Só nele a IA de
 * sempre escolhe a saída pela resposta ao follow-up — e o Jev, ao lado dela.
 */
export function algumFluxoQueClassifica(fluxos: ReadonlyArray<{ versao?: unknown }>): boolean {
  return fluxos.some((f) => {
    const versao = f.versao as { graph?: { nodes?: unknown } } | null | undefined;
    const nos = versao?.graph?.nodes;
    return (
      Array.isArray(nos) &&
      nos.some((n) => {
        const no = n as { type?: unknown; config?: { classes?: unknown } } | null;
        const classes: unknown = no?.type === "ai_classify" ? no.config?.classes : undefined;
        return Array.isArray(classes) && saidasCabemNaPergunta(classes);
      })
    );
  });
}

/**
 * A tarefa do follow-up numa organização em que nenhum follow-up publicado tem
 * o passo "Classificar (IA)" com duas saídas ou mais, e nenhuma inscrição que
 * ainda anda está numa versão com ele: ninguém escolhe saída pela resposta ao
 * follow-up, nada sai para o Jev, e "observando" diria "Ainda não há mensagens
 * medidas pelos dois" para sempre. `temFluxoQueClassifica` é lido por quem chama
 * (`algumFluxoQueClassifica`). As inscrições contam porque o motor não olha o
 * estado do follow-up nem a versão publicada: afirmar "Não roda" enquanto elas
 * mandam respostas ao Jev seria a frase tranquilizadora falsa, numa tela de
 * transferência para fora do país.
 */
export function tarefaSemFluxo(tarefa: Pick<TarefaDoJev, "id">, temFluxoQueClassifica: boolean): boolean {
  return tarefa.id === TAREFA_DO_FOLLOWUP.id && !temFluxoQueClassifica;
}

/**
 * Por que o atendimento automático não roda em NENHUM número da organização —
 * e com ele a regra de hoje: `externo`, o atendimento delegado a um sistema de
 * fora (`ai_dispatch_mode = 'external'`, que o dreno descarta antes de tudo);
 * `ninguem_no_ar`, nenhum número com um agente publicado e não pausado (nem um
 * roteador ativo com um assim) — `haQuemAtendaAOrganizacao`. Lido por quem
 * chama.
 */
export type SemAtendente = "externo" | "ninguem_no_ar";

/**
 * As tarefas em cascata só são perguntadas onde o turno rodaria
 * (`./pedidos.ts`, `turnoRodaria`): sem atendimento automático em número
 * nenhum, o worker nunca as pergunta, e "Só observa" com "nenhuma mensagem" no
 * cartão seria para sempre. As outras tarefas têm os seus motivos
 * (`tarefaSemCamada`, `tarefaSemRoteador`).
 */
export function tarefaSemAtendente(tarefa: Pick<TarefaDoJev, "familia">, motivo: SemAtendente | null): SemAtendente | null {
  return tarefa.familia === "cascata" ? motivo : null;
}
