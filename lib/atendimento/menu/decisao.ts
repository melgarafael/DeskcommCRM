/**
 * O ESTADO DO MENU na conversa e a DECISÃO de cada mensagem — as duas coisas
 * puras desta fatia.
 *
 * ─── Onde o estado mora, e por quê ─────────────────────────────────────────
 *
 * Em `conversations.metadata.menu_de_atendimento`, como o rascunho da ouvidoria
 * (`lib/ouvidoria/whatsapp.ts`): é estado de CONVERSA, não fato de negócio, e a
 * linha da conversa já existe em toda mensagem que chega. Nenhuma migration, e
 * o Inbox já projeta esse jsonb. Toda escrita faz read-modify-write preservando
 * as outras chaves — `metadata` é compartilhado com a tela.
 *
 * ─── A JANELA DE 24 H ──────────────────────────────────────────────────────
 *
 * Estado velho EXPIRA. Sem isso, um cliente que abriu o menu e sumiu deixaria a
 * conversa presa: quando voltasse três dias depois, a mensagem dele seria lida
 * como resposta à opção 2 de uma lista que ele não tem mais na tela. Expirado,
 * o menu é enviado de novo — que é o comportamento de entrada.
 *
 * ─── A decisão é PURA, e é o coração da fatia ───────────────────────────────
 *
 * `decidirPassoDoMenu` recebe o texto, o estado e o menu e devolve o que fazer.
 * Nenhum banco, nenhum relógio escondido (`agora` é parâmetro). É o que torna
 * os quatro caminhos exigidos pela issue — fila, arquivo, opção inválida e flag
 * desligada — testáveis sem dublê de transporte, e o que garante que "opção
 * inválida" não vire laço: o passo é sempre para a FRENTE (repetir → humano).
 */
import { opcaoPeloNumero, type MenuSemIa, type OpcaoDoMenu } from "./modelo";

/** A chave do estado dentro de `conversations.metadata`. */
export const CHAVE_NO_METADATA = "menu_de_atendimento";

/** Depois disto, o menu em espera não vale mais — a conversa recomeça. */
export const VALIDADE_DO_ESTADO_MS = 24 * 60 * 60 * 1000;

/**
 * `aguardando` — o menu foi enviado e a próxima mensagem é a escolha;
 * `repetiu`   — o cliente respondeu algo que não é opção e o menu foi repetido
 *               UMA vez (a próxima resposta inválida cai para humano);
 * `concluido` — a escolha foi aplicada; a conversa segue o caminho normal.
 */
export type SituacaoDoMenu = "aguardando" | "repetiu" | "concluido";

export interface EstadoDoMenu {
  estado: SituacaoDoMenu;
  /** ISO — o relógio da última transição, base da janela de 24 h. */
  atualizado_em: string;
  /** Quantas vezes o menu já foi repetido nesta espera. `1` = já repetiu. */
  repeticao: number;
  /**
   * A mensagem que PROVOCOU este estado. É o que impede a reentrega do webhook
   * (o provedor reenvia o mesmo evento quando a resposta demora) de ser lida
   * como resposta do cliente ao menu que ela mesma acabou de receber.
   */
  ultima_mensagem_id?: string | null;
  /** Por que concluiu — rastro para o log e para quem investiga depois. */
  desfecho?: string;
}

const SITUACOES: readonly SituacaoDoMenu[] = ["aguardando", "repetiu", "concluido"];

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * O estado gravado na conversa, ou `null` (nunca houve, expirou ou é lixo).
 *
 * Não lança: jsonb é escrito por fora e um estado torto não pode derrubar a
 * ingestão — torto é o mesmo que ausente, e o menu é enviado de novo.
 */
export function lerEstadoDoMenu(
  metadata: unknown,
  agora: Date = new Date(),
  validadeMs: number = VALIDADE_DO_ESTADO_MS,
): EstadoDoMenu | null {
  const bruto = objeto(objeto(metadata)?.[CHAVE_NO_METADATA]);
  if (!bruto) return null;

  const estado = bruto.estado;
  if (typeof estado !== "string" || !SITUACOES.includes(estado as SituacaoDoMenu)) return null;

  const atualizadoEm = bruto.atualizado_em;
  if (typeof atualizadoEm !== "string") return null;
  const quando = Date.parse(atualizadoEm);
  if (!Number.isFinite(quando)) return null;
  if (agora.getTime() - quando > validadeMs) return null;

  const repeticao = typeof bruto.repeticao === "number" && Number.isInteger(bruto.repeticao) && bruto.repeticao >= 0
    ? bruto.repeticao
    : 0;

  return {
    estado: estado as SituacaoDoMenu,
    atualizado_em: atualizadoEm,
    repeticao,
    ...(typeof bruto.ultima_mensagem_id === "string" || bruto.ultima_mensagem_id === null
      ? { ultima_mensagem_id: bruto.ultima_mensagem_id as string | null }
      : {}),
    ...(typeof bruto.desfecho === "string" ? { desfecho: bruto.desfecho } : {}),
  };
}

/**
 * O `metadata` da conversa com o estado do menu trocado, preservando as demais
 * chaves. `null` remove a chave (volta a ser conversa sem menu).
 */
export function comEstadoDoMenu(
  metadata: unknown,
  estado: EstadoDoMenu | null,
): Record<string, unknown> {
  const atual = objeto(metadata) ?? {};
  if (estado === null) {
    const { [CHAVE_NO_METADATA]: _descartado, ...resto } = atual;
    return resto;
  }
  return { ...atual, [CHAVE_NO_METADATA]: estado };
}

/**
 * O que fazer com ESTA mensagem. Um passo só, sempre para a frente:
 *
 *   fora_do_menu      → a mensagem não é do menu (flag desligada, menu inválido,
 *                       menu já concluído, ou conversa que nunca viu o menu e
 *                       chega depois de concluído). É o caminho de hoje;
 *   enviar_menu       → primeira mensagem: manda o gatilho e passa a esperar;
 *   escolher          → a resposta é uma opção válida;
 *   repetir           → resposta inválida na PRIMEIRA tentativa: repete uma vez;
 *   cair_para_humano  → resposta inválida na segunda: o cliente não está
 *                       conseguindo escolher, e insistir com ele é pior que
 *                       passar para uma pessoa.
 */
export type PassoDoMenu =
  | { kind: "fora_do_menu"; motivo: string }
  | { kind: "reentrega" }
  | { kind: "enviar_menu" }
  | { kind: "escolher"; opcao: OpcaoDoMenu; posicao: number }
  | { kind: "repetir" }
  | { kind: "cair_para_humano"; motivo: "opcao_invalida" };

export interface EntradaDaDecisao {
  menu: MenuSemIa | null;
  estado: EstadoDoMenu | null;
  texto: string | null | undefined;
  /** A mensagem que chegou AGORA — comparada com a que criou o estado. */
  messageId?: string | null;
}

/**
 * Decide o passo. PURA: nenhum acesso a banco, nenhum `Date.now()`.
 *
 * A ordem das perguntas é a regra: primeiro "existe menu ligado?", depois "a
 * conversa já concluiu?", e só então "o que o cliente respondeu". Inverter o
 * primeiro par faria uma conversa com menu concluído voltar a receber o menu
 * quando a configuração fosse reaberta.
 */
export function decidirPassoDoMenu({
  menu,
  estado,
  texto,
  messageId = null,
}: EntradaDaDecisao): PassoDoMenu {
  if (!menu || menu.ativa !== true) return { kind: "fora_do_menu", motivo: "menu_desligado" };
  if (estado === null) return { kind: "enviar_menu" };

  // REENTREGA: o provedor reenvia o mesmo evento quando a resposta demora. Se o
  // estado foi criado por ESTA mensagem, ela já foi tratada — sem esta saída, a
  // mensagem que RECEBEU o menu seria lida como resposta a ele.
  if (messageId !== null && estado.ultima_mensagem_id === messageId) {
    return { kind: "reentrega" };
  }

  if (estado.estado === "concluido") return { kind: "fora_do_menu", motivo: "menu_concluido" };

  const opcao = opcaoPeloNumero(menu, texto);
  if (opcao) {
    return { kind: "escolher", opcao, posicao: menu.opcoes.indexOf(opcao) + 1 };
  }

  // Já repetiu uma vez: NÃO repete de novo. É aqui que o laço morre — sem este
  // ramo, "bom dia", "oi", "2?" e qualquer coisa fora da lista fariam o cliente
  // receber o menu para sempre.
  if (estado.estado === "repetiu" || estado.repeticao >= 1) {
    return { kind: "cair_para_humano", motivo: "opcao_invalida" };
  }
  return { kind: "repetir" };
}

/** O estado de quem acabou de receber o menu (ou de quem o recebeu de novo). */
export function estadoAguardando(agora: Date, messageId: string | null = null): EstadoDoMenu {
  return {
    estado: "aguardando",
    atualizado_em: agora.toISOString(),
    repeticao: 0,
    ultima_mensagem_id: messageId,
  };
}

/** O estado de quem errou a primeira resposta: o menu foi repetido UMA vez. */
export function estadoRepetiu(agora: Date, messageId: string | null = null): EstadoDoMenu {
  return {
    estado: "repetiu",
    atualizado_em: agora.toISOString(),
    repeticao: 1,
    ultima_mensagem_id: messageId,
  };
}

/** O estado terminal: a escolha foi aplicada (ou o menu caiu para humano). */
export function estadoConcluido(
  agora: Date,
  desfecho: string,
  messageId: string | null = null,
): EstadoDoMenu {
  return {
    estado: "concluido",
    atualizado_em: agora.toISOString(),
    repeticao: 0,
    ultima_mensagem_id: messageId,
    desfecho,
  };
}
