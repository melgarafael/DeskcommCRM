import type { CustomFieldDef } from "@/lib/schemas/settings";

/**
 * O caminho da MÍDIA de um anexo — a porta que a listagem de anexos já serve
 * (`/api/v1/leads/[id]/attachments/[attachmentId]/media`, 302 para a URL
 * assinada do bucket). O card usa o MESMO caminho de propósito: um link direto
 * para o Storage expiraria em 60 s, e uma segunda rota seria uma segunda régua
 * de autorização para o mesmo arquivo.
 */
export function caminhoDaMidiaDoAnexo(leadId: string, attachmentId: string): string {
  return `/api/v1/leads/${leadId}/attachments/${attachmentId}/media`;
}

/** Quantos arquivos o card mostra por campo; o TOTAL continua sendo o real. */
export const MAX_ARQUIVOS_NO_CARD = 3;

/** A linha de `crm_lead_attachments` como o quadro a lê — só o que o card usa. */
export interface LinhaDoAnexoNoQuadro {
  lead_id: string;
  field_key: string;
  id: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | string | null;
  created_at: string | null;
}

export interface ArquivoNoCard {
  id: string;
  nome: string;
  tipo: string;
  tamanho: number;
  href: string;
}

/** Um campo `file` do funil, com o que está anexado nele neste negócio. */
export interface AnexosDoCampoNoCard {
  campo: string;
  rotulo: string;
  /** O total REAL, mesmo quando `arquivos` vem cortado pelo teto do card. */
  total: number;
  arquivos: ArquivoNoCard[];
}

/**
 * Anexa a cada negócio do quadro o que os campos `file` do funil TÊM — o bloco
 * que o card desenha sem abrir o dossiê (#2829, fatia 1).
 *
 * PURA de propósito, como `anexarTarefasAosNegocios` e `anexarDadosDoContato`:
 * a rota do quadro faz UMA leitura de `crm_lead_attachments` para o quadro
 * inteiro e entrega as linhas aqui. O card não pode custar uma consulta por
 * negócio — era o que fazia o quadro engasgar com 200 cards.
 *
 * DUAS diferenças em relação às tarefas, e as duas são o pedido da issue:
 *
 *  1. campo declarado e VAZIO entra com `total: 0`. O selo de tarefas some
 *     quando não há tarefa (o normal é não ter), mas aqui o operador CRIOU o
 *     campo no funil e precisa ver que ele está vazio — sumir transformaria
 *     "documento faltando" em "campo inexistente", que é o defeito de origem;
 *  2. o bloco é por CAMPO, não pelo negócio: um funil pode ter "Comprovante" e
 *     "Voucher" e o card não pode misturar os dois numa contagem só.
 *
 * Funil sem nenhum campo `file` devolve os MESMOS objetos, sem campo novo: o
 * payload do quadro não engorda para quem nunca usou o recurso, e o card não
 * muda em nada. Anexo de chave que o funil já não declara não vira bloco (o
 * arquivo continua na tabela e no dossiê; o card não inventa campo).
 */
export function anexarAnexosAosNegocios<T extends { id: string }>(
  leads: T[],
  linhas: readonly LinhaDoAnexoNoQuadro[],
  campos: readonly Pick<CustomFieldDef, "key" | "label" | "type">[],
): Array<T & { anexos?: AnexosDoCampoNoCard[] }> {
  const deArquivo = campos.filter((campo) => campo.type === "file");
  // Sem campo `file` no funil, o negócio sai como ENTROU (mesmos objetos, sem
  // chave nova): o payload do quadro não engorda para quem não usa o recurso.
  if (deArquivo.length === 0) return leads;

  const porNegocio = new Map<string, Map<string, LinhaDoAnexoNoQuadro[]>>();
  for (const linha of linhas) {
    const porCampo = porNegocio.get(linha.lead_id) ?? new Map<string, LinhaDoAnexoNoQuadro[]>();
    const doCampo = porCampo.get(linha.field_key) ?? [];
    doCampo.push(linha);
    porCampo.set(linha.field_key, doCampo);
    porNegocio.set(linha.lead_id, porCampo);
  }

  return leads.map((lead) => {
    const porCampo = porNegocio.get(lead.id);
    const anexos: AnexosDoCampoNoCard[] = deArquivo.map((campo) => {
      const doCampo = porCampo?.get(campo.key) ?? [];
      // Ordem de upload (mais antigo primeiro), com o id como desempate: duas
      // linhas podem nascer no mesmo segundo e o card não pode trocar de ordem
      // entre um refetch e outro.
      const ordenadas = [...doCampo].sort((a, b) => {
        const ta = a.created_at ?? "";
        const tb = b.created_at ?? "";
        return ta === tb ? a.id.localeCompare(b.id) : ta.localeCompare(tb);
      });
      return {
        campo: campo.key,
        rotulo: campo.label,
        total: ordenadas.length,
        arquivos: ordenadas.slice(0, MAX_ARQUIVOS_NO_CARD).map((linha) => ({
          id: linha.id,
          nome: linha.file_name,
          tipo: linha.mime_type ?? "application/octet-stream",
          tamanho: Number(linha.file_size) || 0,
          href: caminhoDaMidiaDoAnexo(lead.id, linha.id),
        })),
      };
    });
    return { ...lead, anexos };
  });
}
