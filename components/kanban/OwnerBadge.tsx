"use client";
import { useT } from "@/hooks/i18n/useT";
import type { OwnerKind } from "@/lib/types/leads";

/** Iniciais a partir do nome (primeira + última palavra). */
export function ownerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Primeiro e último nome, para a linha curta do card.
 * "Fernanda da Silva Santos" → "Fernanda Santos". Uma palavra fica como está.
 * O nome inteiro continua no `title` — isto só escolhe o que a linha desenha.
 */
export function nomeAbreviado(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "";
  if (partes.length === 1) return partes[0]!;
  return `${partes[0]} ${partes[partes.length - 1]}`;
}

/**
 * Exibe o responsável (owner) de um lead — humano ou agente de IA (0070).
 * Presentacional e sem dnd, testável em isolamento.
 *
 * O agente é PAR do humano, não um enfeite: mesmo diâmetro, mesmo peso, mesma
 * posição. A única diferença é a forma — humano = disco preenchido; agente =
 * círculo vazado com anel e inicial em mono. Nada de emoji, badge "AI"
 * colorido ou gradiente: a distinção é geométrica, não decorativa, e por isso
 * sobrevive ao daltonismo e ao teste do metro.
 */
export function OwnerBadge({
  ownerKind,
  ownerName,
  agentVersion,
  compacto = false,
  foraDaEquipe = false,
  abreviarNome = false,
}: {
  ownerKind: OwnerKind;
  ownerName: string | null;
  /** Versão publicada do agente no momento da exibição (nunca congelada no lead). */
  agentVersion?: number | null;
  /**
   * Variante de 16px, para a linha do inbox — onde os selos vizinhos têm 16px e
   * um disco de 24px empurraria a altura da linha inteira.
   *
   * É uma PROP e não um componente novo de propósito: a geometria (disco cheio =
   * pessoa, anel vazado = automático) é a mesma afirmação, e duplicá-la num
   * segundo arquivo é como duas telas passam a dizer a mesma coisa de dois jeitos.
   */
  compacto?: boolean;
  /** O responsável humano saiu da equipe: o nome fica, e o rótulo avisa. */
  foraDaEquipe?: boolean;
  /**
   * Linha do card do funil: o nome de pessoa vira primeiro + último; o nome
   * do agente não é abreviado, só encolhe. Os dois encolhem com reticências e
   * o nome inteiro fica no `title`. As iniciais não mudam — saem do nome
   * completo, como sempre.
   */
  abreviarNome?: boolean;
}) {
  const t = useT();
  const caixa = abreviarNome ? "min-w-0 flex-1 overflow-hidden" : "";
  const texto = abreviarNome
    ? `min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${compacto ? "text-[10px]" : "text-xs"}`
    : `truncate ${compacto ? "max-w-[7rem] text-[10px]" : "max-w-[9rem] text-xs"}`;
  if (!ownerKind) {
    // Mesma geometria dos outros dois estados (disco de 24px + rótulo), para o
    // rodapé do card não mudar de altura conforme o lead tem dono ou não.
    return (
      <div className={`flex items-center gap-1.5 ${caixa}`} aria-label={t("Sem responsável")}>
        <span
          className={`${compacto ? "h-4 w-4" : "h-6 w-6"} shrink-0 rounded-full border border-dashed border-border-strong`}
          aria-hidden
        />
        <span className={`${texto} text-text-muted`}>{t("Sem responsável")}</span>
      </div>
    );
  }

  const isAgent = ownerKind === "ai";
  const label = ownerName ?? t(isAgent ? "Agente" : "Responsável");
  const versionSuffix = isAgent && agentVersion != null ? ` · v${agentVersion}` : "";
  const saiuSuffix = !isAgent && foraDaEquipe ? ` · ${t("Fora da equipe")}` : "";
  const fullLabel = `${label}${versionSuffix}${saiuSuffix}`;
  // Só nome de pessoa vira primeiro + último. O nome do agente foi escolhido
  // pela equipe ("Agente de Qualificação"); cortar palavras do meio troca o
  // nome — ele só encolhe com reticências.
  const nomeVisivel = abreviarNome && !isAgent && ownerName ? nomeAbreviado(ownerName) : label;

  return (
    <div
      className={`flex items-center gap-1.5 ${caixa}`}
      aria-label={`${t("Responsável")}: ${fullLabel}`}
      title={fullLabel}
    >
      <span
        className={
          isAgent
            ? // Vazado com anel: o fundo do card atravessa o disco.
              `flex ${compacto ? "h-4 w-4 text-[8px]" : "h-6 w-6 text-[10px]"} shrink-0 items-center justify-center rounded-full border border-accent bg-surface font-mono font-semibold text-accent ring-1 ring-accent/40 ring-inset`
            : // Preenchido SÓLIDO: a um metro, o humano é uma mancha escura e o
              // agente é um anel claro. Contraste que não depende da borda —
              // fundo suave fazia os dois lerem como "círculo claro".
              `flex ${compacto ? "h-4 w-4 text-[8px]" : "h-6 w-6 text-[10px]"} shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground`
        }
        aria-hidden
      >
        {ownerName ? ownerInitials(ownerName) : "?"}
      </span>
      <span className={`${texto} text-text-muted`}>{`${nomeVisivel}${saiuSuffix}`}</span>
    </div>
  );
}
