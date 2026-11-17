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
 */
import type { FollowupFlowStatus } from "@/hooks/followup/useFollowupFlows";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

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
 * mesma referência.
 */
export function filtrarFluxos<T extends FluxoBuscavel>(
  fluxos: T[],
  { busca, status }: { busca: string; status: FiltroDeStatusDoFluxo },
): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo && status === "all") return fluxos;
  return fluxos.filter((fluxo) => {
    if (status !== "all" && fluxo.status !== status) return false;
    return !termo || termoSemAcento(fluxo.name).includes(termo);
  });
}
