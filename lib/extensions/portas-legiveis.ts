import { PORTA_DA_CAPACIDADE, type ExtensionPermission } from "./capacidades";

/**
 * O nome de cada porta em português, para a tela mostrar ANTES de alguém aceitar a extensão.
 *
 * Por que isto existe: a tela dizia uma frase só — "Abre Tarefas; não lê seus dados." —
 * derivada de `permissions.includes("navigation.tasks")`. Com uma permissão só, a frase era a
 * verdade inteira. Com a lista fechada (ADR-0003), ela passou a ESCONDER as outras portas: uma
 * extensão que abre Conversas e Contatos mostraria exatamente o mesmo texto de uma que só abre
 * Tarefas, ou — pior — cairia no ramo "não recebe acesso" por não incluir `navigation.tasks`.
 *
 * A lista de permissões é a única coisa que a pessoa tem para decidir. Esconder um item dela é
 * furar, pela tela, a mesma propriedade que o servidor garante por mapa constante.
 *
 * `Record` exaustivo: permissão nova sem nome legível não compila.
 */
const NOME_DA_PORTA: Record<ExtensionPermission, string> = {
  "navigation.tasks": "Tarefas",
  "navigation.inbox": "Conversas",
  "navigation.kanban": "Funil",
  "navigation.contacts": "Contatos",
  "navigation.agenda": "Agenda",
  "navigation.radar": "Radar",
  // `theme.apply` não abre uma tela: pinta o produto com o tema escolhido. O
  // label próprio impede que o `Record` exaustivo deixe de compilar e que a
  // tela de aceite silencie sobre um acesso que está declarado.
  "theme.apply": "Seu tema na tela",
};

export function nomeDaPorta(permissao: ExtensionPermission): string {
  return NOME_DA_PORTA[permissao];
}

/**
 * A frase que a tela mostra. Lista TODAS as portas, em ordem estável, e termina com o limite —
 * porque "abre" e "lê" são coisas diferentes, e é a segunda que as pessoas temem.
 *
 * Recebe o tradutor em vez de devolver português cru, e a razão é um defeito que o gate NÃO
 * pega: `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` varre chamadas `t("literal")` no
 * código. Uma frase MONTADA em tempo de execução nunca é um literal, então ela passaria pelo
 * gate e cairia em português na tela de quem escolheu espanhol — sem nada reprovar.
 * Traduzindo o MOLDE e cada NOME separadamente, as peças voltam a ser literais que o
 * dicionário cobre.
 */
export function portasLegiveis(
  permissoes: readonly ExtensionPermission[],
  t: (texto: string) => string = (texto) => texto,
): string {
  const nomes = [...permissoes]
    .filter((p) => p in NOME_DA_PORTA)
    .sort((a, b) => NOME_DA_PORTA[a].localeCompare(NOME_DA_PORTA[b], "pt-BR"))
    .map((p) => t(nomeDaPorta(p)));
  if (nomes.length === 0) return t("Não abre nenhuma tela e não lê seus dados.");
  const lista =
    nomes.length === 1 ? nomes[0]! : `${nomes.slice(0, -1).join(", ")} ${t("e")} ${nomes.at(-1)!}`;
  return t("Abre {portas}; não lê seus dados.").replace("{portas}", lista);
}

/** Os destinos correspondentes, para quem quiser conferir para onde cada porta leva. */
export function destinosLegiveis(permissoes: readonly ExtensionPermission[]): string[] {
  return Object.entries(PORTA_DA_CAPACIDADE)
    .filter(([, porta]) => permissoes.includes(porta.permissao))
    .map(([, porta]) => porta.destino);
}
