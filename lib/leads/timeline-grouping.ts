import type { TimelineItemView } from "@/lib/types/contacts";

/**
 * O agrupamento da timeline do dossiê.
 *
 * Três regras, e cada uma existe por um defeito específico:
 *
 *  1. COLAPSA por ator E por NATUREZA, não só por ator. `Agente respondeu · 3
 *     ações` é ótimo para relato; mas `next_action_approved` e
 *     `next_action_dismissed` são as ÚNICAS linhas da timeline que contêm uma
 *     DECISÃO e não um relato — escondê-las num bloco é o oposto do que a Wave 4
 *     pagou para construir.
 *
 *  2. O QUE CHEGOU AO VIVO NESTA SESSÃO NÃO COLAPSA. Se o evento novo caísse
 *     dentro de um bloco já fechado, a timeline iria de "3 ações" para "4 ações"
 *     e o usuário NÃO VERIA O QUE CHEGOU: o requisito de agrupar esconderia o
 *     que o requisito de tempo real promete mostrar. Expandir o bloco sozinho
 *     seria pior — mudaria retroativamente o que já está na tela e a pessoa
 *     perde onde estava lendo. Ele se junta ao bloco numa abertura nova.
 *
 *  3. Só colapsa dentro da MESMA JANELA de tempo: eventos do mesmo ator com
 *     horas de distância são episódios diferentes da vida do lead, e juntá-los
 *     apagaria a informação de que houve uma pausa.
 */

/** Tipos que NUNCA colapsam: contêm decisão humana, não relato. */
const NUNCA_COLAPSA = new Set([
  "next_action_approved",
  "next_action_dismissed",
  // A reativação segue a mesma regra: são as linhas que registram alguém
  // DECIDINDO. `expired` entra junto porque a AUSÊNCIA de decisão é a
  // informação — escondê-la num bloco de dia apagaria exatamente o que o
  // vencimento existe para tornar visível.
  "reactivation_accepted",
  "reactivation_dismissed",
  "reactivation_expired",
  // As quatro intervenções no follow-up (0145) entram pelo MESMO critério, e não
  // por analogia: elas só nascem de alguém clicando — o motor não pausa, não
  // adia e não pula. E a janela de 60s as pegaria todas juntas, porque quem
  // intervém costuma fazer duas coisas seguidas (pausa e adia). Escondidas atrás
  // de um "+", o próximo atendente abriria o card e não veria que uma pessoa
  // segurou o fluxo — que é a única razão de a linha existir.
  "followup_paused",
  "followup_resumed",
  "followup_snoozed",
  "followup_step_skipped",
]);

/** Janela do agrupamento. O contrato fala em "mesmo minuto". */
const JANELA_MS = 60_000;

export type BlocoDaTimeline =
  | { tipo: "item"; item: TimelineItemView; aoVivo: boolean }
  | {
      tipo: "grupo";
      /** Quem agiu — o rótulo do bloco sai daqui. */
      actorKind: string;
      itens: TimelineItemView[];
    }
  | {
      /** Bloco GROSSO: um dia inteiro. Só existe em timeline longa (ver `agrupaTimeline`). */
      tipo: "dia";
      /** Chave estável do dia, para React e para testes. */
      dia: string;
      rotulo: string;
      itens: TimelineItemView[];
    };

/**
 * Acima de quantos blocos a lista deixa de informar e passa a ser parede.
 *
 * O GATILHO É O TAMANHO DA LISTA, NUNCA O TEMPO — e isso não é detalhe de
 * implementação. Calibrar por tempo exigiria escolher uma janela olhando os
 * dados disponíveis, e os dados disponíveis aqui são artefato das próprias
 * sondas: medido, o intervalo mediano entre atividades é de 99s contra uma
 * janela de 60s, ou seja, eu estaria ajustando o produto à cadência dos meus
 * testes e produzindo um número sobre nós mesmos com cara de resultado.
 *
 * Tamanho de lista não tem esse problema: "vinte e seis linhas não cabem na
 * cabeça de ninguém" vale igual em qualquer banco.
 */
const LIMITE_DE_BLOCOS = 12;

function chaveDoAtor(item: TimelineItemView): string {
  return `${item.actor_kind ?? "desconhecido"}:${item.actor_agent_id ?? item.performed_by_user_id ?? ""}`;
}

function instante(item: TimelineItemView): number {
  return new Date(item.performed_at).getTime();
}

/**
 * Agrupa a timeline já ordenada (mais recente primeiro, como a rota devolve).
 *
 * `chegouAoVivo` são os ids recebidos por realtime NESTA sessão — eles saem
 * sozinhos, sem exceção, e é isso que faz o novo ser VISTO em vez de contado.
 */
export function agrupaTimeline(
  itens: TimelineItemView[],
  chegouAoVivo: Set<string> = new Set(),
): BlocoDaTimeline[] {
  const fino = agrupaFino(itens, chegouAoVivo);
  return fino.length <= LIMITE_DE_BLOCOS ? fino : agrupaPorDia(itens, chegouAoVivo);
}

/** O dia do item no fuso de quem lê — "24 de julho" é o que a pessoa reconhece. */
function diaDe(item: TimelineItemView): { chave: string; rotulo: string } {
  const d = new Date(item.performed_at);
  const chave = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  let rotulo: string;
  try {
    // `month: "short"` em pt-PT devolve o mês NUMÉRICO ("20/07"), não abreviado
    // como em pt-BR ("20 de jul.") — convenção diferente de CLDR entre as duas
    // variantes. `month: "long"` é textual nas duas, preservando a legibilidade.
    rotulo = new Intl.DateTimeFormat("pt-PT", {
      weekday: "long",
      day: "2-digit",
      month: "long",
    }).format(d);
  } catch {
    rotulo = chave;
  }
  return { chave, rotulo };
}

/**
 * O agrupamento GROSSO — um bloco por dia.
 *
 * As DUAS EXCEÇÕES continuam valendo, e valem aqui por mais razão ainda: quanto
 * mais grosso o agrupamento, mais fácil sumir com a linha que importa.
 *
 *  - decisão humana (`next_action_*`) NUNCA entra num bloco: é o único conteúdo
 *    da timeline que registra alguém DECIDINDO, e esconder decisão dentro de
 *    "quinta-feira · 40 ações" é o oposto do que a wave 4 pagou para construir;
 *  - o que chegou AO VIVO nesta sessão fica fora: senão o evento novo cairia
 *    dentro de um bloco fechado e a timeline iria de "40 ações" para "41 ações"
 *    — o requisito de agrupar escondendo o que o de tempo real promete mostrar.
 *
 * ⚠️ E ELE TRATA O CASO QUE NÃO É "MURO DE BLOCOS": o defeito medido tinha um
 * lead com 26 itens e 26 blocos, ZERO colapsáveis — todos isolados por ator ou
 * por janela. Não era parede de blocos de 2, era AUSÊNCIA DE ESTRUTURA acima da
 * linha. Por isso o agrupamento por dia parte dos ITENS, não dos blocos finos:
 * partir dos blocos deixaria os 26 isolados exatamente como estavam.
 */
function agrupaPorDia(
  itens: TimelineItemView[],
  chegouAoVivo: Set<string>,
): BlocoDaTimeline[] {
  // ⚠️ POR CHAVE, NÃO POR VIZINHANÇA. A primeira versão só juntava dias
  // CONSECUTIVOS, o que funciona enquanto a lista chega ordenada — e ela chega,
  // a rota ordena por `performed_at`. Mas a dependência era invisível: bastava
  // alguém reordenar em memória (por relevância, por ator, por qualquer coisa)
  // para o agrupamento voltar a 26 blocos SEM ERRO NENHUM, só deixando de
  // funcionar. Guardar por chave custa um Map e remove a armadilha.
  //
  // A ORDEM DE APARIÇÃO é preservada: o bloco de um dia nasce onde o primeiro
  // item daquele dia estava, então numa lista ordenada o resultado é idêntico ao
  // da versão por vizinhança.
  const blocos: BlocoDaTimeline[] = [];
  const porDia = new Map<string, BlocoDaTimeline & { tipo: "dia" }>();
  for (const item of itens) {
    const aoVivo = chegouAoVivo.has(item.id);
    if (aoVivo || NUNCA_COLAPSA.has(item.type)) {
      blocos.push({ tipo: "item", item, aoVivo });
      continue;
    }
    const { chave, rotulo } = diaDe(item);
    const existente = porDia.get(chave);
    if (existente) {
      existente.itens.push(item);
      continue;
    }
    const novo = { tipo: "dia" as const, dia: chave, rotulo, itens: [item] };
    porDia.set(chave, novo);
    blocos.push(novo);
  }
  return blocos;
}

/** O agrupamento fino: por ator, dentro da mesma janela. */
function agrupaFino(
  itens: TimelineItemView[],
  chegouAoVivo: Set<string>,
): BlocoDaTimeline[] {
  const blocos: BlocoDaTimeline[] = [];

  for (const item of itens) {
    const aoVivo = chegouAoVivo.has(item.id);
    const isolado = aoVivo || NUNCA_COLAPSA.has(item.type);

    if (isolado) {
      blocos.push({ tipo: "item", item, aoVivo });
      continue;
    }

    const ultimo = blocos[blocos.length - 1];
    const podeJuntar =
      ultimo !== undefined &&
      ultimo.tipo === "grupo" &&
      ultimo.actorKind === chaveDoAtor(item) &&
      Math.abs(instante(ultimo.itens[ultimo.itens.length - 1]!) - instante(item)) <= JANELA_MS;

    if (podeJuntar && ultimo.tipo === "grupo") {
      ultimo.itens.push(item);
      continue;
    }

    // Um item sozinho vira grupo de um; quem renderiza decide mostrar o bloco
    // só a partir de dois. Assim a regra de junção fica num lugar só, em vez de
    // ficar metade aqui e metade no componente.
    blocos.push({ tipo: "grupo", actorKind: chaveDoAtor(item), itens: [item] });
  }

  return blocos;
}

/** Um grupo só é apresentado como bloco quando tem mais de um item. */
export function ehBlocoColapsavel(b: BlocoDaTimeline): boolean {
  return b.tipo === "grupo" && b.itens.length > 1;
}

/** Bloco de dia com um item só não vira bloco: vira a própria linha. */
export function ehBlocoDeDia(b: BlocoDaTimeline): boolean {
  return b.tipo === "dia" && b.itens.length > 1;
}
