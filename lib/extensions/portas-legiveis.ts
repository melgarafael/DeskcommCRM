import { ehPermissaoDeArea } from "./areas";
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
  // `dados.proprios` também não abre tela: o módulo GUARDA fichas próprias na instalação. O nome
  // está aqui para o `Record` exaustivo e para quem lista as concessões uma a uma; a frase da tela
  // o trata à parte, porque "abre" e "guarda" não são a mesma promessa.
  "dados.proprios": "Fichas próprias",
  // Áreas do CRM (spec 33, F1). Não são telas: aparecem numa frase à parte ("Lê ...", "Altera ..."),
  // porque módulo conectado não abre tela do CRM. O nome de cada área é o mesmo nos dois modos.
  "area.contatos.leitura": "Contatos (leitura)",
  "area.contatos.escrita": "Contatos (escrita)",
  "area.negocios.leitura": "Negócios (leitura)",
  "area.negocios.escrita": "Negócios (escrita)",
  "area.conversas.leitura": "Conversas (leitura)",
  "area.conversas.escrita": "Conversas (escrita)",
  "area.agenda.leitura": "Agenda (leitura)",
  "area.agenda.escrita": "Agenda (escrita)",
  "area.funis.leitura": "Funis (leitura)",
  "area.funis.escrita": "Funis (escrita)",
  "area.agentes_ia.leitura": "Agentes de IA (leitura)",
  "area.agentes_ia.escrita": "Agentes de IA (escrita)",
  "area.catalogo.leitura": "Catálogo (leitura)",
  "area.catalogo.escrita": "Catálogo (escrita)",
  "area.configuracao.leitura": "Configuração (leitura)",
  "area.configuracao.escrita": "Configuração (escrita)",
  "area.analise.leitura": "Análise (leitura)",
  "area.analise.escrita": "Análise (escrita)",
};

export function nomeDaPorta(permissao: ExtensionPermission): string {
  return NOME_DA_PORTA[permissao];
}

/** Nome de uma área, sem o modo: "Contatos", "Agentes de IA". Lido do rótulo de leitura. */
function nomeDaArea(permissao: ExtensionPermission): string {
  return NOME_DA_PORTA[permissao].replace(/ \((leitura|escrita)\)$/, "");
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
  // `dados.proprios` sai da lista de "abre": ele não é uma tela, é armazenamento. Misturá-lo na
  // mesma oração faria a tela prometer uma coisa e o módulo fazer outra.
  const guardaDados = permissoes.includes("dados.proprios");
  // As permissões de ÁREA (módulo conectado) não abrem tela: saem desta lista e têm frase própria.
  const nomes = [...permissoes]
    .filter((p) => p !== "dados.proprios" && !ehPermissaoDeArea(p) && p in NOME_DA_PORTA)
    .sort((a, b) => NOME_DA_PORTA[a].localeCompare(NOME_DA_PORTA[b], "pt-BR"))
    .map((p) => t(nomeDaPorta(p)));

  const juntar = (itens: string[]) =>
    itens.length === 1
      ? itens[0]!
      : `${itens.slice(0, -1).join(", ")} ${t("e")} ${itens.at(-1)!}`;

  const areas = permissoes.filter(ehPermissaoDeArea);
  if (areas.length > 0) {
    // Com área declarada, a frase NÃO pode dizer "não lê seus dados": ela lê. Por isso cada
    // parte é uma frase inteira, lida e alterada separadamente, e o limite que sobra é só o dela.
    const nomesDaArea = (modo: "leitura" | "escrita") =>
      areas
        .filter((p) => p.endsWith(`.${modo}`))
        .sort((a, b) => nomeDaArea(a).localeCompare(nomeDaArea(b), "pt-BR"))
        .map((p) => t(nomeDaArea(p)));
    const aLer = nomesDaArea("leitura");
    const aAlterar = nomesDaArea("escrita");
    const partes: string[] = [];
    if (nomes.length > 0) partes.push(t("Abre {portas}.").replace("{portas}", juntar(nomes)));
    if (guardaDados) partes.push(t("Guarda fichas próprias nesta instalação."));
    if (aLer.length > 0) partes.push(t("Lê {areas}.").replace("{areas}", juntar(aLer)));
    if (aAlterar.length > 0) partes.push(t("Altera {areas}.").replace("{areas}", juntar(aAlterar)));
    return partes.join(" ");
  }

  if (nomes.length === 0) {
    return guardaDados
      ? t("Guarda fichas próprias nesta instalação; não lê seus dados.")
      : t("Não abre nenhuma tela e não lê seus dados.");
  }
  const lista = juntar(nomes);
  if (guardaDados) {
    return t("Abre {portas} e guarda fichas próprias nesta instalação; não lê seus dados.").replace(
      "{portas}",
      lista,
    );
  }
  return t("Abre {portas}; não lê seus dados.").replace("{portas}", lista);
}

/** Os destinos correspondentes, para quem quiser conferir para onde cada porta leva. */
export function destinosLegiveis(permissoes: readonly ExtensionPermission[]): string[] {
  return Object.entries(PORTA_DA_CAPACIDADE)
    .filter(([, porta]) => permissoes.includes(porta.permissao))
    .map(([, porta]) => porta.destino);
}
