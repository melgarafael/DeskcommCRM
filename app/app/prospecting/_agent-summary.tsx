"use client";

import type { ReactNode } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { AgentChatDraft } from "@/lib/prospecting/agent-chat-schema";

export function AgentSetupSummary({
  draft,
  channel,
  pipeline,
  initialStage,
  qualifiedStage,
  children,
}: {
  draft: AgentChatDraft;
  channel?: string | null;
  pipeline?: string;
  initialStage?: string;
  qualifiedStage?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const fields = [
    [t("Como vai abordar"), draft.instruction],
    [t("Quando qualificar"), draft.qualification],
    [t("Conexão de saída"), channel],
    [t("Funil"), pipeline],
    [t("Etapa inicial"), initialStage],
    [t("Etapa de qualificados"), qualifiedStage],
  ];
  const filled = fields.filter(([, value]) => !!value).length;
  return (
    <section
      aria-label={t("Resumo do agente")}
      className="min-w-0 space-y-4 rounded-xl border bg-muted/20 p-4 text-sm"
    >
      <div>
        <p className="text-xs font-medium text-muted-foreground">
          {filled === fields.length
            ? t("Pronto para testar e publicar")
            : t("Seu agente está tomando forma")}
        </p>
        <h3 className="mt-1 text-lg font-semibold break-words">{draft.name || t("Novo agente")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {filled} {t("de")} {fields.length} {t("definições preenchidas")}
        </p>
      </div>
      <dl className="space-y-3">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
              {value || t("Vamos definir na conversa")}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {t("Permissões: consultar contatos e atualizar negócios no funil escolhido.")}
      </p>
      {children}
    </section>
  );
}
