/**
 * O QUE A BUSCA DO TOPO (⌘K) DEVOLVE ALÉM DE TELAS (#4593).
 *
 * ═══ O defeito ═══
 *
 * A paleta só conhecia `NAV_DESTINATIONS`: digitar «oficinas» ou «prospeccao
 * site» ali não devolvia O FLUXO nem O FUNIL com esse nome — devolvia a tela em
 * que eles vivem, e a pessoa tinha de procurar de novo no meio de treze itens.
 * Quem já estava na tela certa digitava ⌘K e colhia «nenhum resultado».
 *
 * ═══ A regra ═══
 *
 * As três listas que a comunidade apontou entram como GRUPOS PRÓPRIOS, cada item
 * abrindo o próprio registro (`/app/pipelines/<id>`, `/app/ai/followups/<id>`,
 * `/app/ai/agents/<id>`). O casamento passa por `termoSemAcento`
 * (`lib/inbox/termo-de-busca.ts`) — a régua única do produto, a mesma da paleta
 * para destinos e a mesma das três listas.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A montagem e o filtro são testáveis sem DOM, como `filtrarFluxos` e
 * `filtrarFunis`. O componente não decide casamento: só desenha.
 *
 * ⚠️ QUEM ENXERGA O QUÊ NÃO É DECIDIDO AQUI. Este módulo recebe listas JÁ
 * recortadas por quem as buscou (RLS da rota, papel na tela). Lista vazia = grupo
 * ausente, e é assim que um item que a pessoa não pode ver não aparece.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** Os três grupos que a issue pediu, mais nada. */
export type GrupoDeItensDaBusca = "funis" | "followups" | "agentes";

/**
 * Rótulo e ordem dos grupos. A ORDEM aqui é a ordem na paleta: o grupo que a
 * pessoa procura primeiro (o funil em que trabalha) vem antes do fluxo que roda
 * por trás dele.
 *
 * São textos em português porque são a CHAVE do dicionário — quem traduz é o
 * `t()` da tela, nunca este módulo.
 */
export const GRUPOS_DE_ITENS_DA_BUSCA: readonly {
  id: GrupoDeItensDaBusca;
  label: string;
}[] = [
  { id: "funis", label: "Funis" },
  { id: "followups", label: "Follow-ups" },
  { id: "agentes", label: "Agentes de IA" },
];

/** O mínimo que um item precisa ter para aparecer na paleta. */
export interface ItemDaBusca {
  /** Destino do clique: o REGISTRO, não a lista. */
  href: string;
  label: string;
  description: string;
  group: GrupoDeItensDaBusca;
}

/** O que cada fonte entrega — só o que a paleta desenha e casa. */
export interface FontesDosItensDaBusca {
  funis?: readonly { id: string; name: string }[];
  fluxos?: readonly { id: string; name: string }[];
  agentes?: readonly { id: string; name: string; description?: string | null }[];
}

/** Rótulo de apoio do item — é o que situa a pessoa quando o nome é curto. */
const DESCRICAO_DO_FUNIL = "Funil";
const DESCRICAO_DO_FLUXO = "Fluxo de follow-up";
const DESCRICAO_DO_AGENTE = "Agente de IA";

/**
 * Monta os itens das três fontes, na ordem dos grupos.
 *
 * Fonte ausente ou vazia não gera grupo: a paleta filtra os grupos disponíveis
 * pelo que os itens declaram, então nada aparece vazio.
 *
 * A descrição do agente entra como descrição do ITEM (e portanto casa na busca).
 * Agente sem descrição usa o rótulo do grupo, que não muda o casamento por nome.
 */
export function itensDaBusca(fontes: FontesDosItensDaBusca): ItemDaBusca[] {
  const itens: ItemDaBusca[] = [];

  for (const funil of fontes.funis ?? []) {
    itens.push({
      href: `/app/pipelines/${funil.id}`,
      label: funil.name,
      description: DESCRICAO_DO_FUNIL,
      group: "funis",
    });
  }

  for (const fluxo of fontes.fluxos ?? []) {
    itens.push({
      href: `/app/ai/followups/${fluxo.id}`,
      label: fluxo.name,
      description: DESCRICAO_DO_FLUXO,
      group: "followups",
    });
  }

  for (const agente of fontes.agentes ?? []) {
    itens.push({
      href: `/app/ai/agents/${agente.id}`,
      label: agente.name,
      description: agente.description?.trim() || DESCRICAO_DO_AGENTE,
      group: "agentes",
    });
  }

  return itens;
}

/** Os campos que o termo digitado percorre — os mesmos que a paleta já casa. */
function textoBuscavel(item: ItemDaBusca): string {
  const rotuloDoGrupo =
    GRUPOS_DE_ITENS_DA_BUSCA.find((grupo) => grupo.id === item.group)?.label ?? "";
  return `${item.label} ${item.description} ${rotuloDoGrupo}`;
}

/**
 * Filtra os itens pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira, na MESMA referência —
 * é o catálogo que a paleta mostra antes da primeira letra.
 *
 * Casa com o NOME do item, com a descrição e com o rótulo do grupo: quem digita
 * «agentes» vê os agentes, quem digita «prospeccao site» vê o funil e quem
 * digita «oficinas» vê o fluxo. Os DOIS lados passam pela régua única.
 */
export function filtrarItensDaBusca(itens: ItemDaBusca[], busca: string): ItemDaBusca[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return itens;
  return itens.filter((item) => termoSemAcento(textoBuscavel(item)).includes(termo));
}
