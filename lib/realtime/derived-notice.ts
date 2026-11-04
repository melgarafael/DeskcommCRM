import { prazoEmBr } from "@/lib/lgpd/sla";
import type { RetainedEpisode } from "@/lib/realtime/drain-retained-episodes";
export interface DerivedNotice extends RetainedEpisode {
  organization_id: string;
  kind: "channel_unavailable" | "lgpd_at_risk" | "ai_budget" | "tenant_pending_overflow";
  snapshot: Record<string, unknown>;
  created_at: string;
}
export function formatDerivedNotice(item: DerivedNotice): {
  label: string;
  message: string;
} {
  const s = item.snapshot;
  if (!s || typeof s !== "object") throw new Error("invalid notice snapshot");
  switch (item.kind) {
    case "channel_unavailable":
      if (
        !["ban_suspected", "disconnected_unexpected", "disconnected"].includes(
          String(s.status),
        ) ||
        (s.status_reason !== null && typeof s.status_reason !== "string")
      )
        throw new Error("invalid channel notice");
      return {
        label: "Alerta de conexão",
        message:
          s.status === "ban_suspected"
            ? "Conexão com suspeita de bloqueio"
            : `Sessão desconectada inesperadamente${s.status_reason ? `: ${s.status_reason}` : ""}`,
      };
    case "lgpd_at_risk": {
      if (typeof s.due_at !== "string" || typeof s.overdue !== "boolean")
        throw new Error("invalid deadline notice");
      const date = prazoEmBr(s.due_at);
      if (!date) throw new Error("invalid deadline date");
      return {
        label: "Prazo LGPD",
        message: s.overdue
          ? `Requisição LGPD vencida em ${date}`
          : `Prazo LGPD expira em ${date}`,
      };
    }
    case "ai_budget":
      if (
        typeof s.percent !== "number" ||
        !Number.isFinite(s.percent) ||
        s.percent < 80 ||
        !["avisar", "bloquear"].includes(String(s.mode))
      )
        throw new Error("invalid budget notice");
      return {
        label: "Budget IA",
        message: `Budget IA ${s.percent}% do teto (gasto acumulado)${s.mode === "bloquear" ? " — este tenant escolheu parar a IA no limite" : ""}`,
      };
    case "tenant_pending_overflow":
      if (
        typeof s.count !== "number" ||
        !Number.isInteger(s.count) ||
        s.count <= 50
      )
        throw new Error("invalid pending notice");
      return {
        label: "Overflow de conversas",
        message: `${s.count} conversas pendentes sem atendimento`,
      };
    default:
      throw new Error("unknown notice");
  }
}
