/**
 * As portas que uma extensão pode abrir, e o mapa que as traduz em destino.
 *
 * A propriedade que este módulo existe para preservar, e que vale mais que qualquer
 * conveniência aqui dentro:
 *
 *   **O pacote nunca fornece, compõe nem influencia um endereço.** Ele nomeia uma
 *   capacidade desta lista fechada, e o host traduz o nome num destino que é constante
 *   do código.
 *
 * Por que isso é escrito em vez de resolvido com um prefixo: a saída barata seria aceitar
 * qualquer `href` que comece com `/app/`. Ela alcançaria `/app/settings/api-tokens` e
 * `/app/ai/credentials` — as duas telas onde a instalação guarda segredo — e passaria por
 * todos os testes existentes, porque eles afirmam o destino de hoje e não a regra.
 * `tests/unit/extensoes-capacidade-nao-vem-do-pacote.test.ts` afirma a regra.
 *
 * Régua para incluir uma porta nova: é uma tela de TRABALHO, sujeita à autorização normal
 * de quem clica. Configuração, credencial, cobrança, webhook e administração da instalação
 * ficam fora — uma extensão orienta o trabalho, nunca leva alguém para onde se guarda segredo.
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
] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

/** A capacidade é o que o cartão pede quando a pessoa clica no botão dele. */
export const EXTENSION_CAPABILITIES = [
  "tasks.open",
  "inbox.open",
  "kanban.open",
  "contacts.open",
  "agenda.open",
  "radar.open",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

interface PortaDaCapacidade {
  /** Destino literal. Nunca montado, nunca concatenado, nunca vindo do pacote. */
  readonly destino: string;
  /** A permissão que precisa estar declarada no manifesto para esta capacidade valer. */
  readonly permissao: ExtensionPermission;
}

/**
 * `Record` exaustivo de propósito: uma capacidade nova sem porta não compila, em vez de
 * virar `undefined` em tempo de execução e cair num destino vazio.
 */
export const PORTA_DA_CAPACIDADE: Record<ExtensionCapability, PortaDaCapacidade> = {
  "tasks.open": { destino: "/app/tasks", permissao: "navigation.tasks" },
  "inbox.open": { destino: "/app/inbox", permissao: "navigation.inbox" },
  "kanban.open": { destino: "/app/kanban", permissao: "navigation.kanban" },
  "contacts.open": { destino: "/app/contacts", permissao: "navigation.contacts" },
  "agenda.open": { destino: "/app/agenda", permissao: "navigation.agenda" },
  "radar.open": { destino: "/app/radar", permissao: "navigation.radar" },
};

/** Todos os destinos que o host aceita devolver. A tela reconfere contra este conjunto. */
export const DESTINOS_PERMITIDOS: readonly string[] = Object.values(PORTA_DA_CAPACIDADE).map(
  (porta) => porta.destino,
);

export function ehCapacidade(valor: unknown): valor is ExtensionCapability {
  return (EXTENSION_CAPABILITIES as readonly unknown[]).includes(valor);
}

export function ehPermissao(valor: unknown): valor is ExtensionPermission {
  return (EXTENSION_PERMISSIONS as readonly unknown[]).includes(valor);
}

/**
 * O único caminho para um destino. Recebe a capacidade JÁ validada pelo schema; um valor
 * fora da lista devolve `null`, e quem chama responde recusa — nunca um destino de reserva,
 * que seria exatamente o furo que este módulo evita.
 */
export function destinoDaCapacidade(capacidade: unknown): string | null {
  return ehCapacidade(capacidade) ? PORTA_DA_CAPACIDADE[capacidade].destino : null;
}

export function permissaoDaCapacidade(capacidade: ExtensionCapability): ExtensionPermission {
  return PORTA_DA_CAPACIDADE[capacidade].permissao;
}
