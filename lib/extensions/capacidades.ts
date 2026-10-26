/**
 * As capacidades que uma extensão pode pedir, e o mapa que as traduz em efeito.
 *
 * A propriedade que este módulo existe para preservar, e que vale mais que qualquer
 * conveniência aqui dentro:
 *
 *   **O pacote nunca fornece, compõe nem influencia um endereço nem um efeito.** Ele nomeia
 *   uma capacidade desta lista fechada, e o host a traduz no que é constante do código.
 *
 * Por que isso é escrito em vez de resolvido com um prefixo: a saída barata seria aceitar
 * qualquer `href` que comece com `/app/`. Ela alcançaria `/app/settings/api-tokens` e
 * `/app/ai/credentials` — as duas telas onde a instalação guarda segredo — e passaria por
 * todos os testes existentes, porque eles afirmam o destino de hoje e não a regra.
 * `tests/unit/extensoes-capacidade-nao-vem-do-pacote.test.ts` afirma a regra.
 *
 * ─── Duas naturezas, e por que a distinção é a doutrina ─────────────────────
 *
 *   `porta`  — abre uma tela de TRABALHO que já existe, sujeita à autorização normal de quem
 *              clica. Configuração, credencial, cobrança, webhook e administração da instalação
 *              ficam fora — uma extensão orienta o trabalho, nunca leva alguém para onde se
 *              guarda segredo.
 *   `efeito` — autoriza o HOST a agir na conversa em nome da organização: responder ao contato
 *              e passar o atendimento para uma pessoa. Não abre tela nenhuma; é a autoridade que
 *              o item 3 da doutrina chama de concessão, e ela NUNCA cabe na ativação genérica.
 *
 * Antes desta separação, a lista de capacidades era só de portas, e uma contribuição que age no
 * turno (`turn_flow`) entrava no manifesto sem permissão nenhuma: quem ativava a extensão para
 * abrir Tarefas autorizava, sem ler, que ela falasse com o cliente. É o furo que o mantenedor
 * fechou no #3456 — e o desenho da correção é este: capacidade nomeada ⇒ permissão nomeada ⇒
 * aceite próprio (`lib/extensions/consentimento.ts`).
 *
 * Contexto e o que foi recusado: `docs/adr/0003-perfil-declarativo-v2-portas-nomeadas-e-vitrine.md`.
 */

/** A permissão é o que a tela mostra antes de alguém aceitar a extensão. */
export const EXTENSION_PERMISSIONS = [
  "navigation.tasks",
  "navigation.inbox",
  "navigation.kanban",
  "navigation.contacts",
  "navigation.agenda",
  "navigation.radar",
  // O consentimento para um tema de extensão pintar o produto — mostrado na
  // MESMA tela que lista as demais permissões antes de alguém aceitar a extensão.
  "theme.apply",
  // A concessão de um módulo de DADOS: ele guarda fichas próprias, declaradas no manifesto e
  // compiladas pelo host. Entra na lista porque aparece na MESMA tela de consentimento das outras —
  // um pacote de dados não pede porta de navegação, e dar-lhe uma que ele não usa só para caber na
  // validação seria mentir para quem lê a tela (ADR-0005, D4).
  "dados.proprios",
  // As duas concessões de TURNO (#3076). Não abrem tela: autorizam o host a responder ao contato
  // e a passar a conversa para uma pessoa em nome da organização. São as primeiras permissões que
  // exigem ACEITE PRÓPRIO (`PERMISSOES_QUE_EXIGEM_ACEITE`) porque agem sobre o cliente, e não
  // sobre uma tela que quem clica já podia abrir.
  "turn.send",
  "turn.handoff",
] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

/** Capacidades que abrem uma tela existente. O mapa abaixo é o único caminho para o destino. */
export const CAPACIDADES_DE_PORTA = [
  "tasks.open",
  "inbox.open",
  "kanban.open",
  "contacts.open",
  "agenda.open",
  "radar.open",
] as const;
export type CapacidadeDePorta = (typeof CAPACIDADES_DE_PORTA)[number];

/**
 * Capacidades que autorizam o host a AGIR na conversa. Não têm destino — e é por isso que elas
 * não entram no `PORTA_DA_CAPACIDADE`: dar-lhes uma porta (nem vazia) seria abrir um caminho de
 * navegação para uma capacidade que não navega.
 */
export const CAPACIDADES_DE_EFEITO = ["turn.respond", "turn.handoff"] as const;
export type CapacidadeDeEfeito = (typeof CAPACIDADES_DE_EFEITO)[number];

/** A capacidade é o que a extensão pede: o cartão ao clicar, o fluxo do turno ao declarar. */
export const EXTENSION_CAPABILITIES = [
  ...CAPACIDADES_DE_PORTA,
  ...CAPACIDADES_DE_EFEITO,
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

interface PortaDaCapacidade {
  /** Destino literal. Nunca montado, nunca concatenado, nunca vindo do pacote. */
  readonly destino: string;
  /** A permissão que precisa estar declarada no manifesto para esta capacidade valer. */
  readonly permissao: ExtensionPermission;
}

interface EfeitoDaCapacidade {
  /** O que o host passa a poder fazer. Vocabulário fechado, sem texto do pacote. */
  readonly efeito: "envio" | "passagem";
  /** A permissão que precisa estar declarada no manifesto para esta capacidade valer. */
  readonly permissao: ExtensionPermission;
}

/**
 * `Record` exaustivo de propósito: uma capacidade nova sem porta não compila, em vez de
 * virar `undefined` em tempo de execução e cair num destino vazio.
 */
export const PORTA_DA_CAPACIDADE: Record<CapacidadeDePorta, PortaDaCapacidade> = {
  "tasks.open": { destino: "/app/tasks", permissao: "navigation.tasks" },
  "inbox.open": { destino: "/app/inbox", permissao: "navigation.inbox" },
  "kanban.open": { destino: "/app/kanban", permissao: "navigation.kanban" },
  "contacts.open": { destino: "/app/contacts", permissao: "navigation.contacts" },
  "agenda.open": { destino: "/app/agenda", permissao: "navigation.agenda" },
  "radar.open": { destino: "/app/radar", permissao: "navigation.radar" },
};

/** Mesma disciplina do mapa de portas, para as capacidades que agem na conversa. */
export const EFEITO_DA_CAPACIDADE: Record<CapacidadeDeEfeito, EfeitoDaCapacidade> = {
  "turn.respond": { efeito: "envio", permissao: "turn.send" },
  "turn.handoff": { efeito: "passagem", permissao: "turn.handoff" },
};

/** Todos os destinos que o host aceita devolver. A tela reconfere contra este conjunto. */
export const DESTINOS_PERMITIDOS: readonly string[] = Object.values(PORTA_DA_CAPACIDADE).map(
  (porta) => porta.destino,
);

export function ehCapacidade(valor: unknown): valor is ExtensionCapability {
  return (EXTENSION_CAPABILITIES as readonly unknown[]).includes(valor);
}

export function ehCapacidadeDePorta(valor: unknown): valor is CapacidadeDePorta {
  return (CAPACIDADES_DE_PORTA as readonly unknown[]).includes(valor);
}

export function ehPermissao(valor: unknown): valor is ExtensionPermission {
  return (EXTENSION_PERMISSIONS as readonly unknown[]).includes(valor);
}

/**
 * O único caminho para um destino. Recebe a capacidade JÁ validada pelo schema; um valor
 * fora da lista devolve `null`, e quem chama responde recusa — nunca um destino de reserva,
 * que seria exatamente o furo que este módulo evita.
 *
 * `turn.respond`/`turn.handoff` devolvem `null` como qualquer nome fora da lista: elas não
 * navegam. Se um dia devolvessem uma string, o cartão de uma extensão de turno viraria um link —
 * e o link, montado pelo host, iria para onde o pacote nunca escolheu.
 */
export function destinoDaCapacidade(capacidade: unknown): string | null {
  return ehCapacidadeDePorta(capacidade) ? PORTA_DA_CAPACIDADE[capacidade].destino : null;
}

export function permissaoDaCapacidade(capacidade: ExtensionCapability): ExtensionPermission {
  return ehCapacidadeDePorta(capacidade)
    ? PORTA_DA_CAPACIDADE[capacidade].permissao
    : EFEITO_DA_CAPACIDADE[capacidade].permissao;
}
