/**
 * OS MÓDULOS DA LATERAL DO INBOX (#3008) — quais aparecem e em que ordem.
 *
 * A lateral reúne contato, tags, carteira, demandas, tarefas, follow-up,
 * memória, leads, compras, pedidos, atividade e acervo. Nem todo atendimento
 * precisa de todos: um time de vendas vive de leads e pedidos, um de suporte
 * vive de demandas e atividade — e a mesma pilha de treze blocos serve aos
 * dois, carregada. A issue pede duas coisas, e só duas: escolher QUAIS módulos
 * aparecem e em QUE ORDEM, por pessoa, com um botão para voltar ao padrão.
 *
 * ═══ O PADRÃO É A TELA DE HOJE, E ISSO É CONTRATO ═══
 *
 * `modulosPadrao()` devolve exatamente a lista e a ordem que a lateral desenha
 * hoje, todos visíveis. Quem nunca abriu o diálogo — a maioria — não pode ver
 * a tela mudar por causa desta feature, e quem já configurou não pode ver um
 * módulo NOVO nascer escondido (ver `normalizarModulos`).
 *
 * ═══ POR QUE A PREFERÊNCIA VIVE NO METADATA DA PESSOA ═══
 *
 * Medido no repo, há duas casas para preferência de tela:
 *
 *   - COOKIE (`inbox_painel_recolhido`, `sidebar_collapsed`), para o que muda a
 *     GEOMETRIA da tela e precisa ser lido no SSR sem ida ao banco;
 *   - `raw_user_meta_data` (`lembretes_de_tarefa`, #2529, e `locale`/`timezone`
 *     do perfil), para o que é decisão da PESSOA.
 *
 * Esta é a segunda: a issue pede "salvar as preferências individualmente para
 * cada usuário", e cookie é por NAVEGADOR — dois atendentes no mesmo
 * computador dividiriam a lateral, e o mesmo atendente em duas máquinas veria
 * duas laterais. O metadata é por pessoa (`auth.users.id`), escrita pela
 * própria pessoa com a sessão dela (`updateUser`), sem migration nova e legível
 * no servidor para o primeiro paint.
 *
 * ═══ O METADATA É DADO ALHEIO E ENVELHECE ═══
 *
 * `lerModulosDaLateral` nunca lança e nunca devolve menos que a lista inteira:
 *
 *   - valor torto (texto, número, objeto sem `id`) → o módulo é DESCARTADO;
 *   - id que não existe mais no catálogo → descartado (módulo removido do
 *     produto não pode virar item fantasma no diálogo);
 *   - id repetido → a PRIMEIRA ocorrência manda, as seguintes caem ("reordenar
 *     não pode duplicar módulo");
 *   - id do catálogo que NÃO veio → entra no fim, VISÍVEL ("reordenar não pode
 *     perder módulo"): um bloco novo nasce aparecendo, como nasceu para todo
 *     mundo, em vez de nascer escondido por uma preferência que ninguém deu.
 *
 * E só `false` esconde: `"false"`, `0`, `null` ou ausente deixam o módulo
 * visível. Esconder por engano é o erro caro (a pessoa perde a seção e não
 * sabe onde reencontrá-la); mostrar é recuperável em dois cliques.
 */

import { z } from "zod";

/**
 * O catálogo, NA ORDEM EM QUE A LATERAL DESENHA HOJE — de cima para baixo.
 *
 * A ordem desta lista é o padrão do produto, e é por isso que ela é a única
 * fonte: `modulosPadrao()` deriva daqui, e o teste do padrão compara a tela com
 * esta constante em vez de repetir a lista à mão.
 *
 * Os ids são kebab-case porque são o que a pessoa vê no `data-modulo` do DOM e
 * no metadata gravado — nome estável, nunca rótulo traduzido.
 */
export const MODULOS_DA_LATERAL = [
  "contato",
  "tags-do-contato",
  "carteira",
  "anuncio",
  "perfil-enriquecido",
  "tags-da-conversa",
  "demandas",
  "tarefas",
  "followup",
  "memoria",
  "roteiros",
  "leads",
  "compras",
  "pedidos",
  "atividade",
  "acervo",
] as const;

export type IdModuloDaLateral = (typeof MODULOS_DA_LATERAL)[number];

/** Onde a preferência é gravada no `raw_user_meta_data` da pessoa. */
export const CHAVE_DOS_MODULOS = "modulos_da_lateral";

/**
 * O que o diálogo escreve em cada linha — o MESMO título que o bloco desenha,
 * para a escolha ter o nome do que aparece na tela. As treze chaves já
 * existiam no dicionário (são os títulos das seções); as duas novas entram no
 * `dicionario.ts` com espanhol.
 */
export const ROTULO_DO_MODULO: Record<IdModuloDaLateral, string> = {
  contato: "Contato",
  "tags-do-contato": "Tags do contato",
  carteira: "Carteira",
  anuncio: "Anúncio de origem",
  "perfil-enriquecido": "Sobre a empresa",
  "tags-da-conversa": "Tags da conversa",
  demandas: "Demandas abertas",
  tarefas: "Tarefas desta demanda",
  followup: "Follow-up",
  memoria: "Memória do contato",
  roteiros: "Respostas dos roteiros de atendimento",
  leads: "Leads recentes",
  compras: "Últimas compras",
  pedidos: "Pedidos recentes",
  atividade: "Atividade",
  acervo: "Acervo",
};

export interface ModuloDaLateral {
  id: IdModuloDaLateral;
  visivel: boolean;
}

/**
 * O padrão do produto: todos os módulos, na ordem de `MODULOS_DA_LATERAL`.
 *
 * Devolve cópias, e não a constante: quem chama ordena e desliga à vontade, e
 * mutar o padrão de todo mundo por acidente é o tipo de defeito que só aparece
 * no segundo usuário.
 */
export function modulosPadrao(): ModuloDaLateral[] {
  return MODULOS_DA_LATERAL.map((id) => ({ id, visivel: true }));
}

export function ehIdDeModulo(valor: unknown): valor is IdModuloDaLateral {
  return typeof valor === "string" && (MODULOS_DA_LATERAL as readonly string[]).includes(valor);
}

/**
 * O que a action de gravar aceita (Server Action é endpoint público: o tipo do
 * parâmetro não chega ao servidor). Mora AQUI, e não na action, porque um
 * arquivo "use server" só pode exportar função async — exportar a schema de lá
 * derrubava o módulo inteiro no `next start` (a mesma cicatriz do #2529).
 *
 * O teto de itens não é decoração: a lista é reescrita no metadata da pessoa, e
 * um array de dez mil entradas é um vetor de inflar a própria conta.
 */
export const moduloDaLateralSchema = z.object({
  id: z.string().refine(ehIdDeModulo, "modulo_desconhecido"),
  visivel: z.boolean(),
});

export const modulosDaLateralSchema = z
  .array(moduloDaLateralSchema)
  .min(1)
  .max(MODULOS_DA_LATERAL.length * 2);

/**
 * A lista COMPLETA e sem repetição, a partir de qualquer entrada.
 *
 * É a régua única das duas pontas: a leitura (metadata gravado) e a gravação
 * (o que o diálogo manda) passam por aqui. Duas réguas diferentes deixariam a
 * tela mostrar uma coisa e o banco guardar outra — e o "volta ao padrão ao
 * recarregar" que o #2529 pagou.
 *
 * Entrada que não é array (ou array só com lixo) devolve o PADRÃO, não uma
 * lista vazia: lateral sem módulo nenhum não é um estado que a tela saiba
 * desenhar.
 */
export function normalizarModulos(entrada: unknown): ModuloDaLateral[] {
  if (!Array.isArray(entrada)) return modulosPadrao();

  const vistos = new Set<IdModuloDaLateral>();
  const ordenados: ModuloDaLateral[] = [];
  for (const item of entrada) {
    if (typeof item !== "object" || item === null) continue;
    const cru = item as Record<string, unknown>;
    if (!ehIdDeModulo(cru.id) || vistos.has(cru.id)) continue;
    vistos.add(cru.id);
    ordenados.push({ id: cru.id, visivel: cru.visivel !== false });
  }

  if (ordenados.length === 0) return modulosPadrao();

  // Os que faltaram entram no FIM e VISÍVEIS: módulo novo no produto nasce
  // aparecendo, como nasceu para quem nunca configurou nada.
  for (const id of MODULOS_DA_LATERAL) {
    if (!vistos.has(id)) ordenados.push({ id, visivel: true });
  }
  return ordenados;
}

/**
 * Lê a preferência do `raw_user_meta_data` inteiro (não da chave): quem chama
 * já tem o objeto de metadata na mão — a tela, do `getUser`; a action, do
 * `updateUser` — e a leitura tolerante mora num lugar só.
 */
export function lerModulosDaLateral(metadata: unknown): ModuloDaLateral[] {
  if (typeof metadata !== "object" || metadata === null) return modulosPadrao();
  return normalizarModulos((metadata as Record<string, unknown>)[CHAVE_DOS_MODULOS]);
}

/**
 * Move um módulo de `de` para `para`, sem perder nem duplicar ninguém.
 *
 * Pura e exportada porque o `onDragEnd` do diálogo é a única coisa que o
 * `@hello-pangea/dnd` faz que vale a pena medir: o arrasto em si é do pacote,
 * e o que pode dar errado é a conta do índice. Fora de faixa devolve a MESMA
 * lista (mesma referência), para o `onDragEnd` não redesenhar à toa.
 */
export function moverModulo(
  modulos: readonly ModuloDaLateral[],
  de: number,
  para: number,
): ModuloDaLateral[] {
  if (de === para) return modulos as ModuloDaLateral[];
  if (de < 0 || para < 0 || de >= modulos.length || para >= modulos.length) {
    return modulos as ModuloDaLateral[];
  }
  const copia = [...modulos];
  // `de` já passou pela faixa acima: o `splice` devolve exatamente um item.
  const [movido] = copia.splice(de, 1) as [ModuloDaLateral];
  copia.splice(para, 0, movido);
  return copia;
}
