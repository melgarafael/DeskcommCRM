/**
 * Os campos personalizados do contato como o TITULAR os lê no relatório de
 * acesso: o rótulo da pergunta que os coletou (do grafo do roteiro) em vez da
 * chave técnica, e sem o CPF — que tem linha própria no relatório, e cujo valor
 * o PDF não imprime (política de `cpf_present`; o valor vai no `data.json`).
 *
 * Puro e sem importar o motor de fluxos: o worker de export carrega sob tsx.
 */
export interface CampoLegivel {
  rotulo: string;
  valor: string;
}

interface Pergunta {
  label: string;
  type: string;
}

/** key → pergunta, de todos os grafos de roteiro do contato (o mais recente vence). */
export function perguntasDosGrafos(grafos: readonly unknown[]): Map<string, Pergunta> {
  const mapa = new Map<string, Pergunta>();
  for (const g of grafos) {
    const nodes = (g as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      const no = n as { type?: unknown; config?: { key?: unknown; label?: unknown; type?: unknown } };
      const c = no.config;
      if (no.type !== "collect" || typeof c?.key !== "string" || mapa.has(c.key)) continue;
      mapa.set(c.key, {
        label: typeof c.label === "string" && c.label.trim() ? c.label : legivel(c.key),
        type: typeof c.type === "string" ? c.type : "text",
      });
    }
  }
  return mapa;
}

/** `modelo_interesse` → "Modelo interesse": para chave sem pergunta conhecida. */
export function legivel(chave: string): string {
  const texto = chave.replace(/[_-]+/g, " ").trim();
  return texto ? texto[0]!.toUpperCase() + texto.slice(1) : chave;
}

export function camposLegiveis(
  customFields: Record<string, unknown>,
  perguntas: Map<string, Pergunta>,
): { campos: CampoLegivel[]; cpfInformado: boolean } {
  const campos: CampoLegivel[] = [];
  let cpfInformado = false;
  for (const [chave, bruto] of Object.entries(customFields)) {
    if (bruto === null || bruto === undefined || bruto === "") continue;
    const pergunta = perguntas.get(chave);
    if (pergunta?.type === "cpf" || (!pergunta && chave.toLowerCase() === "cpf")) {
      cpfInformado = true;
      continue;
    }
    campos.push({
      rotulo: pergunta?.label ?? legivel(chave),
      valor: typeof bruto === "string" ? bruto : JSON.stringify(bruto),
    });
  }
  return { campos, cpfInformado };
}
