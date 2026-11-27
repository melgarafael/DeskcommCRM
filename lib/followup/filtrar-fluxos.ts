/**
 * A BUSCA DA LISTA DE FOLLOW-UPS — função pura, fora do componente (#4593).
 *
 * Quem tem muitos fluxos (o caso da issue: mais de 13 fluxos de retomada, um
 * por nicho, com nomes parecidos que o cartão corta) não achava um fluxo sem
 * rolar a lista inteira. A tela ganha a mesma caixa de busca da lista de
 * Agentes, e esta função é a régua dela.
 *
 * ═══ A régua ═══
 *
 * A mesma de `filtrarAgentes` (`lib/ai/agents/filtrar-agentes.ts`): os DOIS
 * lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`). Normalizar
 * só o termo deixaria `"Retomada mecânica".includes("mecanica")` falso.
 *
 * O filtro por status entra aqui também, e não no componente, porque a ordem
 * importa: o status recorta, o termo procura dentro do recorte — e os dois
 * juntos são testáveis sem DOM.
 *
 * ═══ Por palavra, e não por trecho (#4593, o que o #4693 deixou aberto) ═══
 *
 * Cada palavra digitada precisa aparecer no nome OU num dos `textosExtras`, em
 * qualquer ordem (`casaTodasAsPalavras`): «oficina kelly» acha «Kelly ·
 * retomada (oficinas mecânicas)». Os textos extras são o que a TELA decide
 * mostrar como buscável — em Follow-ups, o rótulo do gatilho («Silêncio»,
 * «Etapa do funil»…), em português e no idioma ativo.
 */
import type { FollowupFlowStatus } from "@/hooks/followup/useFollowupFlows";
import { casaTodasAsPalavras, palavrasDaBusca } from "@/lib/inbox/termo-de-busca";

/** O filtro de status da lista: um dos três estados do fluxo, ou todos. */
export type FiltroDeStatusDoFluxo = FollowupFlowStatus | "all";

/** O mínimo que a busca enxerga do fluxo: o nome do cartão e o status do selo. */
export interface FluxoBuscavel {
  name: string;
  status: FollowupFlowStatus;
}

/**
 * Filtra os fluxos pelo status escolhido e pelo termo digitado, preservando a
 * ordem recebida.
 *
 * Status `all` com termo vazio (ou só espaços) devolve a lista inteira, na
 * mesma referência. Sem `textosExtras`, o termo casa só com o nome.
 */
export function filtrarFluxos<T extends FluxoBuscavel>(
  fluxos: T[],
  {
    busca,
    status,
    textosExtras,
  }: {
    busca: string;
    status: FiltroDeStatusDoFluxo;
    /** Mais textos em que o termo pode casar, além do nome. */
    textosExtras?: (fluxo: T) => readonly (string | null | undefined)[];
  },
): T[] {
  const palavras = palavrasDaBusca(busca);
  if (palavras.length === 0 && status === "all") return fluxos;
  return fluxos.filter((fluxo) => {
    if (status !== "all" && fluxo.status !== status) return false;
    return casaTodasAsPalavras(palavras, [fluxo.name, ...(textosExtras?.(fluxo) ?? [])]);
  });
}
