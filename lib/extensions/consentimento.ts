/**
 * O ACEITE da organização para as concessões que agem na conversa (#3076).
 *
 * ─── Por que um módulo só para isto ────────────────────────────────────────
 *
 * O item 3 da doutrina é uma frase curta — **instalar não é autorizar** — e o #3456 mostrou
 * como é fácil furá-la sem tocar em nenhuma linha proibida: o manifesto passou a aceitar
 * `contributions.turn_flow` e, com isso, uma extensão ativada para ABRIR TAREFAS ganhou o
 * direito de responder ao cliente e de passar o atendimento para uma pessoa. Nenhuma tela
 * dizia isso, nenhum aceite existia, e o conjunto de permissões do banco continuava com sete
 * nomes de navegação, tema e dados.
 *
 * A correção tem três elos, e este arquivo é o segundo:
 *
 *   1. `lib/extensions/capacidades.ts` — a capacidade do turno tem PERMISSÃO NOMEADA
 *      (`turn.send`, `turn.handoff`), e o manifesto que declara o fluxo precisa declará-las
 *      (`checkCompatibility`).
 *   2. **aqui** — a permissão nomeada só vale com ACEITE PRÓPRIO do dono da organização. Este
 *      módulo é a política, pura: recebe o que o manifesto declara, o que a organização aceitou
 *      e o fluxo, e responde se o turno pode ser dirigido pela extensão.
 *   3. o gancho (`lib/agent-engine/agent/gancho-de-extensao.ts`) — não age sem o aceite, e sem
 *      ele o turno é o de sempre: a IA responde.
 *
 * ─── Por que \"cobre\", e não \"é igual\" ───────────────────────────────────
 *
 * A comparação é de SUBCONJUNTO: o que o fluxo precisa tem de estar no que a organização aceitou.
 * A cobertura recusa concessão parcial, mas não muda a doutrina 6-bis: atualizar ou
 * desfazer com outro conjunto de permissões segue recusado pela RPC real. Quem
 * precisa de outro conjunto publica outra identidade.
 *
 * `turn.context` é leitura opcional, com aceite próprio. Precisa estar declarada
 * quando o fluxo pede contexto; não aceitá-la não impede a coleta pela mensagem
 * atual. O host jamais a deduz do aceite de envio/passagem.
 *
 * Módulo puro: não fala com banco, canal nem relógio. É importado pelo servidor e pelo navegador.
 */
import {
  EFEITO_DA_CAPACIDADE,
  type CapacidadeDeEfeito,
  type ExtensionPermission,
} from "./capacidades";
import type { FluxoDoTurno } from "./fluxo-do-turno";

/**
 * As permissões que NÃO se cobrem com a ativação genérica: envio, passagem e
 * leitura opcional do contexto já selecionado da conversa. Uma permissão nova que também aja
 * (mandar template, mover dinheiro) entra AQUI, e o teste da lista impede que ela entre só no
 * vocabulário e passe despercebida.
 */
export const PERMISSOES_QUE_EXIGEM_ACEITE = [
  "turn.send",
  "turn.handoff",
  "turn.context",
] as const satisfies readonly ExtensionPermission[];
export type PermissaoQueExigeAceite = (typeof PERMISSOES_QUE_EXIGEM_ACEITE)[number];

/** As permissões do turno — o recorte que a tela do aceite mostra junto. */
export const PERMISSOES_DE_TURNO = PERMISSOES_QUE_EXIGEM_ACEITE;
export type PermissaoDeTurno = PermissaoQueExigeAceite;

export function ehPermissaoDeTurno(valor: unknown): valor is PermissaoDeTurno {
  return (PERMISSOES_DE_TURNO as readonly unknown[]).includes(valor);
}

export function exigeAceite(permissao: ExtensionPermission): boolean {
  return (PERMISSOES_QUE_EXIGEM_ACEITE as readonly ExtensionPermission[]).includes(permissao);
}

/**
 * As capacidades derivadas do desfecho e da declaração opcional de contexto.
 *
 * Declarar seria pedir que o pacote fosse honesto duas vezes sobre a mesma coisa: um fluxo que
 * responde ao cliente e diz que não usa `turn.respond` ficaria com a permissão mais estreita e
 * agiria com a mais larga. Derivando do vocabulário, a única fonte é o desfecho.
 */
export function capacidadesDoFluxo(
  fluxo: Pick<FluxoDoTurno, "desfecho" | "contexto">,
): readonly CapacidadeDeEfeito[] {
  return ["turn.respond", ...(fluxo.desfecho.tipo === "passar_para_humano" ? ["turn.handoff" as const] : []),
    ...(fluxo.contexto === undefined ? [] : ["turn.context" as const])];
}

/** As permissões nomeadas que o fluxo exige — o mapa do host é a única tradução. */
export function permissoesDoFluxo(
  fluxo: Pick<FluxoDoTurno, "desfecho" | "contexto">,
): readonly PermissaoDeTurno[] {
  return capacidadesDoFluxo(fluxo).map(
    (capacidade) => EFEITO_DA_CAPACIDADE[capacidade].permissao as PermissaoDeTurno,
  );
}

/**
 * O que falta para o turno poder ser dirigido por esta extensão. `null` = pode.
 *
 * A ORDEM dos motivos é a da leitura de quem depura: primeiro o contrato (o manifesto declara o
 * que o fluxo usa), depois o aceite (a organização concedeu). Sem a primeira, a segunda seria
 * uma comparação entre conjuntos que nunca poderiam coincidir.
 */
export type MotivoDeRecusaDoTurno =
  /** O manifesto declara `turn_flow` sem a permissão que a capacidade do fluxo exige. */
  | "sem_permissao_declarada"
  /** A organização nunca aceitou nenhuma permissão de turno deste pacote. */
  | "sem_aceite"
  /** O aceite existe, mas não cobre os efeitos necessários do fluxo. */
  | "aceite_desatualizado";

export interface EntradaDoAceite {
  /** `manifest.permissions` da versão VIGENTE. */
  declaradas: readonly ExtensionPermission[];
  /** `organization_extensions.accepted_permissions` — o que o dono da organização aceitou. */
  aceitas: readonly ExtensionPermission[];
  fluxo: Pick<FluxoDoTurno, "desfecho" | "contexto">;
}

export function motivoDeRecusaDoTurno(entrada: EntradaDoAceite): MotivoDeRecusaDoTurno | null {
  const declaracaoExigida = permissoesDoFluxo(entrada.fluxo);
  const necessarias = declaracaoExigida.filter((p) => p !== "turn.context");
  const declaradas = new Set(entrada.declaradas);
  if (declaracaoExigida.some((permissao) => !declaradas.has(permissao))) {
    return "sem_permissao_declarada";
  }
  if (entrada.aceitas.length === 0) return "sem_aceite";
  // A cobertura mora em `aceiteCobre`, e não numa segunda cópia aqui: eram duas expressões do
  // mesmo subconjunto, e a que ficasse para trás seria a que decide (a função existia só para o
  // teste, o que é a definição de regra que ninguém executa).
  return aceiteCobre(necessarias, entrada.aceitas) ? null : "aceite_desatualizado";
}

/** A cobertura, sozinha, para quem já sabe que o manifesto declara tudo. */
export function aceiteCobre(
  necessarias: readonly ExtensionPermission[],
  aceitas: readonly ExtensionPermission[],
): boolean {
  const conjunto = new Set(aceitas);
  return necessarias.every((permissao) => conjunto.has(permissao));
}

/**
 * O conjunto que a organização pode aceitar: as permissões de turno QUE O MANIFESTO DECLARA.
 *
 * Aceitar uma permissão que o pacote não pede seria conceder autoridade para um efeito que ele
 * não tem — e a linha do tempo passaria a dizer \"o dono aceitou X\" sobre um X que nunca foi
 * oferecido. A RPC do banco revalida a mesma regra; esta função é a régua que a tela usa para
 * montar o pedido.
 */
export function permissoesAceitaveis(
  declaradas: readonly ExtensionPermission[],
): readonly PermissaoDeTurno[] {
  return PERMISSOES_DE_TURNO.filter((permissao) => declaradas.includes(permissao));
}

/**
 * O que um aceite novo precisa somar ao anterior para cobrir o que a versão vigente usa.
 *
 * Lista só o que falta para conduzir a coleta. A leitura opcional é oferecida
 * separadamente na tela, sem concedê-la junto com os efeitos necessários.
 */
export function aceitePendente(entrada: EntradaDoAceite): readonly PermissaoDeTurno[] {
  // Leitura é opcional e tem aceite próprio; não impede a coleta só com a mensagem atual.
  const necessarias = permissoesDoFluxo(entrada.fluxo).filter((p) => p !== "turn.context");
  const aceitas = new Set(entrada.aceitas);
  return necessarias.filter((permissao) => !aceitas.has(permissao));
}
