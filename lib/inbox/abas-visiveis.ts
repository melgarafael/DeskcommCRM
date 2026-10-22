import type { Role, VisibilityMode } from "@/lib/auth/types";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "archived" | "ai";

/**
 * A faixa na ORDEM DO TRABALHO (#2498): primeiro o que o robô conduz, depois o
 * que espera gente, depois o histórico. Antes "Automático" fechava a faixa,
 * depois de dois passados — o valor que o operador mais olha era o último.
 *
 * Só a ordem mudou: mesmos `value`, mesmos rótulos, mesmas permissões
 * (`visibleInboxTabs` filtra sem reordenar) e mesmas contagens (`countFor` lê
 * por chave, e a chave não acompanha a posição). `moveTab` anda pelo MESMO
 * array, então as setas continuam vizinha a vizinha.
 */
export const INBOX_TABS: { value: InboxTab; label: string }[] = [
  // "Automático", não "IA": a palavra deste ator já é contrato em quatro arquivos
  // e no dicionário, e `handoff-por-orcamento.test.ts` usa literalmente "Voltar
  // para a IA" como a sabotagem que deve reprovar. O rótulo não mudou quando o
  // significado mudou (deixou de filtrar `ai_handling` e passou a perguntar a
  // régua do motor) — e a posição sim: ela era a última fora do padrão.
  { value: "ai", label: "Automático" },
  { value: "unassigned", label: "Fila" },
  { value: "mine", label: "Minhas" },
  { value: "all", label: "Todas" },
  { value: "closed", label: "Fechadas" },
  // "Arquivadas" fica ao lado de "Fechadas" porque as duas são passado — e
  // separada dela porque são passados diferentes (#923): fechada é atendimento
  // encerrado, arquivada é o que saiu da fila de trabalho sem ser destruído.
  { value: "archived", label: "Arquivadas" },
];

/**
 * Visões visíveis por papel + escopo (G4-02, acceptance 1). 'Todas' fica oculta
 * para `agent` quando visibility_mode ≠ 'all'; viewer/manager/admin sempre veem.
 * É apenas cosmético — a RLS (G4-01) é quem garante o escopo mesmo via ?filter=all.
 */
export function visibleInboxTabs(role: Role, mode: VisibilityMode | undefined): InboxTab[] {
  const hideAll = role === "agent" && mode !== "all";
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll)).map((t) => t.value);
}

