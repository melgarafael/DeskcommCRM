import type { Stage } from "@/lib/kanban/types";

/**
 * A BARRA DE ETAPAS do dossiê — a regra, sem tela.
 *
 * A barra desenha o CAMINHO do negócio no funil: as etapas abertas em
 * sequência, a atual em destaque, as anteriores como percorridas e as
 * seguintes neutras. Ela não decide nada sobre mover: quem move é quem chama
 * (`onMudar`), pelo mesmo fio do seletor `EtapaNoDossie`.
 *
 * ─── Ganho e perda ficam FORA ───────────────────────────────────────────────
 *
 * `is_won`/`is_lost` não são "a próxima etapa": são desfechos, com ações
 * próprias (marcar venda, marcar perda com motivo). Pô-los na fila de setas
 * diria que perder é o passo seguinte de quem está em negociação. O seletor do
 * cabeçalho continua listando as duas — é por ele que se chega ao desfecho a
 * partir do dossiê.
 *
 * ─── Negócio parado num desfecho ────────────────────────────────────────────
 *
 * Se a etapa atual é de ganho ou perda (ou não está na lista), não há "etapa
 * atual" na barra, e desenhar tudo como "seguinte" mentiria sobre o caminho já
 * feito. `montarBarraDeEtapas` devolve `null` e a barra não aparece.
 */

export type EstadoDaEtapaNaBarra = "anterior" | "atual" | "seguinte";

export type EtapaDaBarra = Pick<Stage, "id" | "name"> & Partial<Pick<Stage, "is_won" | "is_lost">>;

export interface PassoDaBarra {
  id: string;
  nome: string;
  estado: EstadoDaEtapaNaBarra;
}

export interface BarraDeEtapasMontada {
  passos: PassoDaBarra[];
  /** Posição da etapa atual, começando em 1 — o "Etapa 2 de 6". */
  posicaoAtual: number;
  total: number;
}

/** Desfecho (ganho ou perda): não entra na barra. */
export function ehDesfecho(etapa: EtapaDaBarra): boolean {
  return etapa.is_won === true || etapa.is_lost === true;
}

/**
 * Monta os passos NA ORDEM RECEBIDA. A ordem é responsabilidade de quem passa
 * as etapas (o quadro ordena por `ordenarEtapasDoFunil`, a página lê por
 * `position`) — a barra e o seletor leem a MESMA lista, e reordenar só aqui
 * faria os dois discordarem.
 */
export function montarBarraDeEtapas(
  etapas: readonly EtapaDaBarra[],
  etapaAtualId: string,
): BarraDeEtapasMontada | null {
  const abertas = etapas.filter((e) => !ehDesfecho(e));
  const indiceAtual = abertas.findIndex((e) => e.id === etapaAtualId);
  if (indiceAtual < 0) return null;

  return {
    passos: abertas.map((e, i) => ({
      id: e.id,
      nome: e.name,
      estado: i < indiceAtual ? "anterior" : i === indiceAtual ? "atual" : "seguinte",
    })),
    posicaoAtual: indiceAtual + 1,
    total: abertas.length,
  };
}

const DIA_EM_MS = 86_400_000;

/**
 * Dias INTEIROS desde a entrada na etapa.
 *
 * A entrada é `crm_leads.stage_changed_at`, carimbada por gatilho em toda troca
 * de etapa (migration 0071) — o mesmo relógio do rodapé do card
 * (`buildCardInput`) e do gatilho "parado N dias na etapa". O `created_at` é a
 * reserva do negócio sem carimbo (dado legado), pela mesma razão de lá: é a
 * única data honesta. `last_activity_at` NÃO serve: uma nota zeraria o relógio.
 *
 * Sem nenhuma das duas, `null` — e a barra mostra só o nome.
 */
export function diasNaEtapa(
  lead: { stage_changed_at?: string | null; created_at?: string | null },
  agora: Date = new Date(),
): number | null {
  const entrada = lead.stage_changed_at ?? lead.created_at ?? null;
  if (!entrada) return null;
  const desde = new Date(entrada).getTime();
  if (Number.isNaN(desde)) return null;
  return Math.max(0, Math.floor((agora.getTime() - desde) / DIA_EM_MS));
}
