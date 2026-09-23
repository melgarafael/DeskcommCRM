/**
 * O follow-up falando português — tradução de TODO valor de wire que o
 * construtor de fluxo mostra a quem não programa.
 *
 * Módulo puro: sem React, sem import de UI. Quem renderiza escolhe o
 * componente; aqui mora só a palavra.
 *
 * ## Por que o operador não tem tradução própria
 *
 * "é igual a" solto não ajuda ninguém, e para `tag` ele MENTE: o motor guarda
 * etiqueta como lista (`LeadFacts.tags`) e trata `eq`/`contains` como "está
 * entre as tags" (`node-handlers.ts` → `evaluateCheck`). Um seletor que
 * mostrasse "é igual a" prometeria comparação de igualdade onde o motor faz
 * pertinência. Por isso a unidade de tradução aqui é o PAR (campo, operador) —
 * `comparador()` —, nunca dois dicionários independentes.
 *
 * ## O que este módulo NÃO possui (fonte da verdade declarada)
 *
 * - Rótulo de aresta (`Sempre` / `Sim` / `Não` / `Sem resposta`) e nome de
 *   classe da IA: `edge-condition-options.ts`. Classes são vocabulário ABERTO
 *   (o usuário escreve as suas), então não há mapa fechado a manter aqui.
 * - Rótulo e ícone de TIPO de nó (`Gatilho`, `Aguardar`, …): `nodeVisuals.ts`.
 *
 * O que este módulo possui são os VALORES de configuração — o que está dentro
 * de cada nó, mais os estados que o acompanhamento assume depois de rodar.
 *
 * ## O que MUDA na tela quando a Wave 2 aplicar isto
 *
 * A maior parte destes rótulos ainda não está em uso — só o nó final consome o
 * dicionário hoje, e com as mesmas palavras de antes. Quando os outros
 * formulários passarem a ler daqui, estes textos mudam de propósito:
 * `E (todas)` → "Todas as condições"; `Adaptativo (min–max)` → "A IA escolhe a
 * hora"; `Template fixo` → "Modelo de mensagem pronto"; `Pausado (handoff)` →
 * "Pausado — um humano assumiu"; `Morto` → "Parou por falha". Os que estão sob
 * contrato de e2e (Convertido, Esgotado, Manual, Silêncio) ficam ao pé da letra.
 *
 * Cobertura vigiada por `vocabulario.test.ts`, que deriva a lista de valores do
 * próprio schema (Zod) e dos tipos de `node-handlers.ts` — nenhuma cópia à mão.
 */
import type { z } from "zod";

import type { TriggerConfig } from "./api-schemas";
import { conditionLabel } from "./edge-condition-options";
import {
  CONDITION_FALSE_BRANCH_ID,
  CONDITION_TRUE_BRANCH_ID,
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  REPEAT_BODY_BRANCH_ID,
  REPEAT_DONE_BRANCH_ID,
  type RESERVED_BRANCH_IDS,
  type actionConfigSchema,
  type aiClassifyConfigSchema,
  type conditionConfigSchema,
  type endConfigSchema,
  type waitConfigSchema,
} from "./graph-schema";
import type { EnrollmentOutcome, EnrollmentStatus } from "./node-handlers";

type ConditionConfig = z.infer<typeof conditionConfigSchema>;
type Check = ConditionConfig["checks"][number];

export type CampoDaCondicao = Check["field"];
export type OperadorDaCondicao = Check["op"];
export type Combinador = ConditionConfig["combinator"];
export type ModoDeRamificacao = NonNullable<ConditionConfig["branching"]>;
export type RamoReservado = (typeof RESERVED_BRANCH_IDS)[number];
export type AlvoDaClassificacao = z.infer<typeof aiClassifyConfigSchema>["target"];
export type ResultadoDoFim = z.infer<typeof endConfigSchema>["outcome"];
export type ModoDeEspera = z.infer<typeof waitConfigSchema>["mode"];
export type ModoDaAcao = z.infer<typeof actionConfigSchema>["mode"];
export type TipoDeGatilho = TriggerConfig["kind"];

/** `{ valor, rotulo }` na ordem de declaração do mapa — pronto para um `<Select>`. */
export function opcoes<K extends string>(mapa: Record<K, string>): ReadonlyArray<{ valor: K; rotulo: string }> {
  return (Object.keys(mapa) as K[]).map((valor) => ({ valor, rotulo: mapa[valor] }));
}

// ─── condição: campo ─────────────────────────────────────────────────────

/**
 * Que tipo de valor o campo compara — o que a tela precisa saber para escolher
 * o controle certo. `etapa` é o caso que hoje sangra: o motor compara contra o
 * `stage_id` (um UUID, veja `engine.ts` → `loadLeadFacts`), então um campo de
 * texto livre pede ao dono da clínica que digite um identificador interno.
 */
export type TipoDeValor = "etapa" | "etiqueta" | "numero" | "texto";

export interface CampoDeCondicao {
  rotulo: string;
  tipoDeValor: TipoDeValor;
}

export const CAMPOS_DA_CONDICAO: Record<CampoDaCondicao, CampoDeCondicao> = {
  lead_stage: { rotulo: "Etapa do funil", tipoDeValor: "etapa" },
  tag: { rotulo: "Etiqueta do contato", tipoDeValor: "etiqueta" },
  steps_taken: { rotulo: "Passos já dados no fluxo", tipoDeValor: "numero" },
  last_outcome: { rotulo: "Desfecho do passo anterior", tipoDeValor: "texto" },
};

// ─── condição: o par (campo, operador) ───────────────────────────────────

export interface Comparador {
  /** Item do seletor de operador — já escrito para ser lido junto com o campo. */
  rotulo: string;
  /** A checagem inteira em uma frase, com o valor no lugar. */
  frase: (valor: string | number) => string;
  /**
   * Entra no seletor deste campo? `false` quando o motor entende o par mas
   * oferecê-lo confunde: ou repete um operador que já está na lista, ou nunca
   * dá certo. Um par fora do seletor continua descritível — fluxo salvo antes
   * desta regra precisa ser lido, não escondido.
   */
  oferecido: boolean;
  /** Presente quando o motor NUNCA satisfaz o par: a tela deve avisar em vez de fingir. */
  aviso?: string;
}

const AVISO_SO_NUMERO =
  "Comparar maior/menor só funciona com número. Do jeito que está, esta condição nunca é verdadeira.";
const AVISO_SO_TEXTO = "“Contém” só funciona com texto. Em número, esta condição nunca é verdadeira.";

/**
 * Regra ainda sem valor. Aspas vazias (`“”`) se liam como "a etapa de nome
 * vazio" — uma regra com cara de pronta. É o estado em que toda regra nova
 * nasce, e o publish a recusa até alguém preencher.
 */
export const VALOR_A_PREENCHER = "(a preencher)";

/**
 * Etapa cujo id não tem nome: apagada, de outra organização, ou a leitura dos
 * nomes falhou. O uuid não é nome de nada para quem lê — e entre aspas pareceria.
 */
export const ETAPA_NAO_ENCONTRADA = "(não encontrada)";

const semValor = (valor: string | number): boolean => String(valor).trim() === "";

/** Texto do SISTEMA no lugar do valor: vai sem aspas, para não se ler como algo que a pessoa escreveu. */
const aspas = (valor: string | number): string =>
  semValor(valor) ? VALOR_A_PREENCHER : valor === ETAPA_NAO_ENCONTRADA ? valor : `“${valor}”`;

const FORMA_DE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O valor tem forma de identificador interno (uuid) — nunca é algo que a pessoa digitou. */
export function temFormaDeId(valor: string | number): boolean {
  return FORMA_DE_ID.test(String(valor).trim());
}

function passos(valor: string | number): string {
  if (semValor(valor)) return `${VALOR_A_PREENCHER} passos`;
  const n = Number(valor);
  return Number.isFinite(n) && Math.abs(n) === 1 ? `${valor} passo` : `${valor} passos`;
}

/**
 * A frase de cada par. Ordem das chaves = ordem no seletor (o mais usado
 * primeiro), então mexer na ordem aqui mexe na tela.
 */
const COMPARADORES: Record<CampoDaCondicao, Record<OperadorDaCondicao, Comparador>> = {
  lead_stage: {
    eq: {
      rotulo: "está na etapa",
      frase: (v) => `O lead está na etapa ${aspas(v)}`,
      oferecido: true,
    },
    neq: {
      rotulo: "não está na etapa",
      frase: (v) => `O lead não está na etapa ${aspas(v)}`,
      oferecido: true,
    },
    contains: {
      rotulo: "contém",
      frase: (v) => `O identificador da etapa do lead contém ${aspas(v)}`,
      oferecido: false,
      aviso:
        "A etapa é comparada pelo identificador interno, não pelo nome — escolha a etapa em vez de digitar um pedaço dela.",
    },
    gte: {
      rotulo: "é pelo menos",
      frase: (v) => `A etapa do lead é pelo menos ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
    lte: {
      rotulo: "é no máximo",
      frase: (v) => `A etapa do lead é no máximo ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
  },
  tag: {
    // O par que dá nome à regra deste módulo: no motor, `tag` é lista.
    eq: {
      rotulo: "tem a etiqueta",
      frase: (v) => `O contato tem a etiqueta ${aspas(v)}`,
      oferecido: true,
    },
    neq: {
      rotulo: "não tem a etiqueta",
      frase: (v) => `O contato não tem a etiqueta ${aspas(v)}`,
      oferecido: true,
    },
    contains: {
      // Mesmo resultado que `eq` (o motor testa pertinência nos dois): descreve
      // o que está salvo, mas não repete a opção no seletor.
      rotulo: "tem a etiqueta",
      frase: (v) => `O contato tem a etiqueta ${aspas(v)}`,
      oferecido: false,
    },
    gte: {
      rotulo: "é pelo menos",
      frase: (v) => `A etiqueta do contato é pelo menos ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
    lte: {
      rotulo: "é no máximo",
      frase: (v) => `A etiqueta do contato é no máximo ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
  },
  steps_taken: {
    gte: {
      rotulo: "é pelo menos",
      frase: (v) => `O fluxo já deu pelo menos ${passos(v)}`,
      oferecido: true,
    },
    lte: {
      rotulo: "é no máximo",
      frase: (v) => `O fluxo já deu no máximo ${passos(v)}`,
      oferecido: true,
    },
    eq: {
      rotulo: "é exatamente",
      frase: (v) => `O fluxo já deu exatamente ${passos(v)}`,
      oferecido: true,
    },
    neq: {
      rotulo: "não é",
      frase: (v) => `O fluxo não deu exatamente ${passos(v)}`,
      oferecido: true,
    },
    contains: {
      rotulo: "contém",
      frase: (v) => `O número de passos contém ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_TEXTO,
    },
  },
  last_outcome: {
    eq: {
      rotulo: "foi",
      frase: (v) => `O desfecho do passo anterior foi ${aspas(v)}`,
      oferecido: true,
    },
    neq: {
      rotulo: "não foi",
      frase: (v) => `O desfecho do passo anterior não foi ${aspas(v)}`,
      oferecido: true,
    },
    contains: {
      rotulo: "contém",
      frase: (v) => `O desfecho do passo anterior contém ${aspas(v)}`,
      oferecido: true,
    },
    gte: {
      rotulo: "é pelo menos",
      frase: (v) => `O desfecho do passo anterior é pelo menos ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
    lte: {
      rotulo: "é no máximo",
      frase: (v) => `O desfecho do passo anterior é no máximo ${aspas(v)}`,
      oferecido: false,
      aviso: AVISO_SO_NUMERO,
    },
  },
};

/** Como se lê o par (campo, operador). Total: todo par salvo tem descrição, mesmo o que não se oferece mais. */
export function comparador(campo: CampoDaCondicao, op: OperadorDaCondicao): Comparador {
  return COMPARADORES[campo][op];
}

/** Só os operadores que fazem sentido para este campo — a lista do `<Select>`. */
export function comparadoresDoCampo(
  campo: CampoDaCondicao,
): ReadonlyArray<{ op: OperadorDaCondicao; rotulo: string }> {
  return (Object.keys(COMPARADORES[campo]) as OperadorDaCondicao[])
    .filter((op) => COMPARADORES[campo][op].oferecido)
    .map((op) => ({ op, rotulo: COMPARADORES[campo][op].rotulo }));
}

/**
 * Como transformar um valor salvo no que a pessoa escolheu. A etapa é gravada
 * pelo `stage_id` — é o que o motor compara —, e só quem tem a lista de etapas
 * (a tela, a rota) sabe o nome. Este módulo é puro, então o nome chega injetado.
 */
export interface NomesDeValor {
  /** «Etapa · Funil» da etapa com este id, ou `null` quando nenhuma etapa tem esse id. */
  etapa?: (id: string) => string | null;
}

/** A checagem inteira em uma frase — para resumo do nó, `aria-label` e revisão antes de publicar. */
export function fraseDaCondicao(
  campo: CampoDaCondicao,
  op: OperadorDaCondicao,
  valor: string | number,
  nomes: NomesDeValor = {},
): string {
  return comparador(campo, op).frase(valorExibido(campo, valor, nomes));
}

function valorExibido(campo: CampoDaCondicao, valor: string | number, nomes: NomesDeValor): string | number {
  if (campo !== "lead_stage" || semValor(valor)) return valor;
  const texto = String(valor).trim();
  const nome = nomes.etapa?.(texto);
  if (nome) return nome;
  // Sem nome resolvido, um fluxo antigo que guardou o NOME digitado ("PAGO")
  // continua legível — o formulário e o publish avisam que ele não aponta para
  // etapa nenhuma. Já um id sem nome não tem o que mostrar.
  return temFormaDeId(texto) ? ETAPA_NAO_ENCONTRADA : valor;
}

/**
 * A regra que é verdadeira para TODO contato. Não é erro de digitação: o
 * contador de passos nasce em zero e só soma (`engine.ts`), então "pelo menos 0"
 * (ou menos) sempre vale. No modo uma-saída-por-regra ela leva todo mundo e as
 * saídas seguintes — inclusive "Nenhuma delas" — nunca são usadas. Era o padrão
 * do produto até este conserto, e continua digitável: a tela avisa enquanto se
 * escreve, que é quando dá para mudar de ideia.
 */
export function regraValeSempre(campo: CampoDaCondicao, op: OperadorDaCondicao, valor: string | number): boolean {
  if (campo !== "steps_taken" || op !== "gte") return false;
  const n = Number(String(valor).trim());
  return String(valor).trim() !== "" && Number.isFinite(n) && n <= 0;
}

export const COMBINADORES: Record<Combinador, string> = {
  and: "Todas as condições",
  or: "Qualquer uma das condições",
};

/**
 * Grafo v2: como o nó de condição abre as saídas dele. `combined` avalia tudo
 * junto e sai por Sim/Não; `per_check` dá uma saída por regra, endereçada pelo
 * id estável do ramo.
 */
export const MODOS_DE_RAMIFICACAO: Record<ModoDeRamificacao, string> = {
  combined: "Uma saída para todas as regras juntas",
  per_check: "Uma saída para cada regra",
};

/**
 * Os ramos que o contrato reserva. Não redeclaramos o texto: ele vem de
 * `conditionLabel`, que já é a fonte da verdade do rótulo que a aresta mostra
 * no canvas — assim o painel e o desenho não podem divergir.
 */
/**
 * Os mesmos ramos, em frase — o registro do DOSSIÊ, não o da etiqueta.
 *
 * Dois registros de propósito. "Sem resposta" cabe num chip ao lado de uma
 * aresta, onde o contexto está no desenho; "quando ninguém responde" cabe numa
 * linha de histórico, onde a frase precisa se sustentar sozinha. Achatar os
 * dois num só empobrece as duas telas.
 *
 * As três primeiras frases são as que `eventos-legiveis.ts` já escrevia à mão
 * para o dialeto v1. Centralizá-las aqui é o que impede o risco real do v2: o
 * mesmo fluxo lido de dois jeitos conforme o ramo chegue como `class_match`
 * (v1) ou como `branch_id` (v2). Um dicionário, duas portas, um texto.
 */
/**
 * O escape de um nó que JÁ tem saídas específicas, em frase. "caminho normal"
 * (abaixo) descreve a única saída de um nó simples; ao lado de "quando a IA
 * classifica como “Interessado”", ele sugeriria o caminho PRINCIPAL — e é o
 * contrário: só se sai por aqui quando nenhuma outra saída serve.
 */
export const FRASE_DE_OUTROS_CASOS = "nos outros casos";

export const RAMOS_RESERVADOS_EM_FRASE: Record<RamoReservado, string> = {
  [FALLBACK_BRANCH_ID]: "caminho normal",
  [NO_REPLY_BRANCH_ID]: "quando ninguém responde",
  [CONDITION_TRUE_BRANCH_ID]: "quando a condição é verdadeira",
  [CONDITION_FALSE_BRANCH_ID]: "quando a condição é falsa",
  [REPEAT_BODY_BRANCH_ID]: "quando ainda falta uma volta",
  [REPEAT_DONE_BRANCH_ID]: "quando as voltas acabaram",
};

/**
 * A frase de um ramo qualquer, reservado ou declarado pelo usuário.
 *
 * `rotuloDeclarado` vem do NÓ (`branches[].label` no classificar,
 * `checks[].label` no condicional), porque no contrato v2 é lá que a identidade
 * do ramo mora. Sem ele, o melhor honesto é dizer que é um caminho sem nome —
 * nunca ecoar o `branch_id`, que é identificador interno.
 */
export function fraseDoRamo(branchId: string): string | null {
  return RAMOS_RESERVADOS_EM_FRASE[branchId as RamoReservado] ?? null;
}

/**
 * Uma frase deste módulo encaixada depois de "quando".
 *
 * As frases nascem como oração completa e maiúscula ("O contato tem a etiqueta
 * …") porque também são lidas sozinhas, no resumo do nó. Emendar a maiúscula no
 * meio de outra frase é o tipo de detalhe que ninguém revisa e todo mundo lê.
 */
function encaixa(frase: string): string {
  return frase.charAt(0).toLocaleLowerCase("pt-BR") + frase.slice(1);
}

/**
 * Ramo de uma CLASSE da IA. Nomeia a IA como quem julgou, de propósito: quem lê
 * o histórico precisa saber que um modelo decidiu, não uma regra fixa.
 */
export function fraseDaClasse(nomeDaClasse: string): string {
  return `quando a IA classifica a resposta como “${nomeDaClasse}”`;
}

/** Ramo de uma REGRA que o usuário batizou. Regra do negócio não é resposta de ninguém. */
export function fraseDaRegraNomeada(rotulo: string): string {
  return `quando vale a regra “${rotulo}”`;
}

/**
 * Ramo de uma regra SEM nome: em vez do id, a própria condição por extenso.
 * `regra-2` na tela do operador é o defeito que este módulo existe para impedir.
 */
export function fraseDaRegraSemNome(
  campo: CampoDaCondicao,
  op: OperadorDaCondicao,
  valor: string | number,
  nomes: NomesDeValor = {},
): string {
  return `quando ${encaixa(fraseDaCondicao(campo, op, valor, nomes))}`;
}

export const RAMOS_RESERVADOS: Record<RamoReservado, string> = {
  [FALLBACK_BRANCH_ID]: conditionLabel({ type: "always" }),
  [NO_REPLY_BRANCH_ID]: conditionLabel({ type: "class_match", value: NO_REPLY_BRANCH_ID }),
  [CONDITION_TRUE_BRANCH_ID]: conditionLabel({ type: "cond_result", value: true }),
  [CONDITION_FALSE_BRANCH_ID]: conditionLabel({ type: "cond_result", value: false }),
  [REPEAT_BODY_BRANCH_ID]: "Próxima volta",
  [REPEAT_DONE_BRANCH_ID]: "Acabou",
};

// ─── classificação pela IA ───────────────────────────────────────────────

const MINIMO_MINUTOS_DE_ESPERA = 15;

/**
 * O antigo "Grace (minutos, mín. 15)" — que não é palavra nenhuma para o dono
 * de uma loja. O rótulo agora diz o que acontece, e a ajuda nomeia o caminho
 * exato que o fluxo pega, com o MESMO texto que a aresta mostra no canvas
 * (`edge-condition-options.ts`) — se aquele rótulo mudar, esta frase acompanha.
 *
 * Semântica real (`engine.ts` → `applyResult`, caso `enqueue_turn`): ao entrar
 * no nó, o acompanhamento vai para `waiting_reply` e volta a ser avaliado em
 * `grace_timeout_ms`. Vencido o prazo sem classificação concluída, o nó segue
 * pela aresta `no_reply` sem chamar o modelo.
 */
export const ESPERA_PELA_RESPOSTA = {
  rotulo: "Esperar a resposta por (minutos)",
  /**
   * Função, não string: o texto cita o rótulo da aresta (`conditionLabel`,
   * também traduzível) e o mínimo em minutos, então só pode ser composto no
   * idioma de quem olha — não pré-computado em português uma vez só. `t`
   * default identidade preserva quem chama sem tradução (ex.: os testes deste
   * arquivo, que conferem o texto em português).
   */
  ajuda: (t: (texto: string) => string = (s) => s) =>
    `${t("Se o contato não responder dentro desse tempo, o fluxo segue sozinho pelo caminho")} ` +
    `“${t(conditionLabel({ type: "class_match", value: "no_reply" }))}”. ` +
    `${t("Mínimo de")} ${MINIMO_MINUTOS_DE_ESPERA} ${t("minutos.")}`,
  minimoMinutos: MINIMO_MINUTOS_DE_ESPERA,
} as const;

export const SE_INFORMACAO_JA_EXISTIR = {
  rotulo: "Se a informação já existir",
  ajuda: "A captação ou a ficha podem já ter o nome (ou o campo). Escolha se o fluxo pula, pergunta de novo ou pede confirmação.",
  skip: "Pular este passo",
  overwrite: "Perguntar de novo e substituir",
  confirm: "Confirmar com o usuário",
} as const;

export function fraseDeConfirmacao(valor: string, destino: "contact_name" | "lead_custom"): string {
  const v = valor.trim();
  if (destino === "contact_name") {
    return `O nome que temos é ${v}. Responda SIM para confirmar ou envie o nome correto.`;
  }
  return `Temos "${v}" neste campo. Responda SIM para confirmar ou envie o valor correto.`;
}

export const ALVOS_DA_CLASSIFICACAO: Record<AlvoDaClassificacao, string> = {
  last_reply: "Última resposta",
  summary: "Resumo",
};

// ─── espera e ação ───────────────────────────────────────────────────────

export const MODOS_DE_ESPERA: Record<ModoDeEspera, string> = {
  fixed: "Tempo fixo",
  smart: "A IA escolhe a hora",
};

export const MODOS_DA_ACAO: Record<ModoDaAcao, string> = {
  text: "Texto fixo",
  ai_message: "Mensagem escrita pela IA",
  template: "Modelo de mensagem pronto",
};

// ─── nó final ────────────────────────────────────────────────────────────

/**
 * Rótulo VISÍVEL e sob contrato: `tests/e2e/followup-journey.spec.ts` escolhe a
 * opção "Convertido" pelo nome e confere "Esgotado" no card. Mudar a palavra
 * aqui quebra aquele spec — o que é o ponto: a mudança passa a ser deliberada.
 */
export const RESULTADOS_DO_FIM: Record<ResultadoDoFim, string> = {
  converted: "Convertido",
  exhausted: "Esgotado",
  custom: "Personalizado",
};

// ─── o acompanhamento depois de rodar ────────────────────────────────────

/**
 * Situação de um `followup_enrollment`. Duas divergem do que a Fila mostra
 * hoje (`QueueTab.tsx`), de propósito, e a Wave 2 unifica: "Pausado (handoff)"
 * usa jargão que ninguém de fora entende, e "Morto" descreve o sistema em vez
 * do que a pessoa precisa fazer — `dead` é o estado que abre aviso na Central.
 */
export const SITUACOES_DO_ACOMPANHAMENTO: Record<EnrollmentStatus, string> = {
  active: "Em andamento",
  waiting_reply: "Aguardando resposta",
  // Não é "pausado": ninguém a parou e ela tem hora para voltar. Quem lê a fila
  // precisa saber que este acompanhamento está vivo e só não fala agora.
  dormente: "Aguardando a data do retorno",
  paused_handoff: "Pausado — um humano assumiu",
  completed: "Concluído",
  cancelled: "Cancelado",
  dead: "Parou por falha",
};

/** Como o acompanhamento terminou. Sem tradução em lugar nenhum do produto até aqui. */
export const DESFECHOS: Record<EnrollmentOutcome, string> = {
  converted: "Convertido",
  replied: "O contato respondeu",
  exhausted: "Esgotado",
  opted_out: "Pediu para parar",
  handoff: "Passou para um humano",
};

// ─── gatilho do fluxo ────────────────────────────────────────────────────

/**
 * "Manual" e "Silêncio" são o texto que `TriggerConfigControl.tsx` já mostra e
 * que `followup-builder.spec.ts` seleciona pelo nome — mantidos ao pé da letra.
 */
export const GATILHOS: Record<TipoDeGatilho, string> = {
  appointment_no_show:"Falta confirmada pela equipe",
  manual: "Manual",
  webhook: "Disparado por uma automação em Webhooks",
  silence: "Silêncio",
  stage_change: "Mudança de etapa no funil",
  // "Caso" é a palavra que a tela de escalação já usa. O rótulo diz o FATO que
  // dispara ("o agente pediu ajuda"), não o nome da tabela — quem lê é dono de
  // clínica, não quem escreveu o schema.
  case_opened: "Quando o agente pede ajuda de um humano",
  inbound_after_silence: "Cliente voltou",
  conversation_end: "Fim da conversa",
};
