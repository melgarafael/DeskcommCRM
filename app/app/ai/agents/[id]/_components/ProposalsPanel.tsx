"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
/**
 * Aba "Propostas" do agente (Operação Visível F3): melhorias que o flywheel
 * destilou das conversas reais. NADA se aplica sozinho — o botão é o gate
 * humano; aplicar cria uma versão NOVA do agente (publish-por-ponteiro).
 */
import { formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentProposals, useApplyProposal, type ProposalRow } from "@/hooks/ai/useAgentProposals";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { Brain } from "@/lib/ui/icons";

const TYPE_LABEL: Record<ProposalRow["type"], string> = {
  playbook_bullet: "Regra de playbook",
  golden_case: "Caso exemplar",
  reentry_trigger: "Gatilho de reengajamento",
  org_memory_entry: "Memória da organização",
};

export function ProposalsPanel({
  agentId,
  active,
  readOnly,
}: {
  agentId: string;
  active: boolean;
  readOnly?: boolean;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading } = useAgentProposals(agentId, active);
  const apply = useApplyProposal(agentId);

  const handleApply = async (p: ProposalRow) => {
    try {
      await apply.mutateAsync(p.id);
      toast.success(
        p.type === "org_memory_entry"
          ? t("Proposta aplicada como memória da organização.")
          : t("Proposta aplicada como versão nova do agente."),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não foi possível aplicar a proposta."));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border py-16 text-center">
        <Brain size={28} className="text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{t("Nenhuma proposta ainda")}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t(
            "O assistente aprende com as conversas reais e propõe melhorias aqui. Você decide o que entra — nada é aplicado sozinho.",
          )}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((p) => {
        const when = formatDistanceToNowStrict(new Date(p.proposed_at), {
          addSuffix: true,
          locale: localeDaData,
        });
        return (
          <li key={p.id} className="flex items-start gap-3 px-4 py-3" data-testid="proposal-item">
            <Badge variant={p.applied_at ? "success" : "info"} className="mt-0.5 shrink-0">
              {p.applied_at ? t("aplicada") : t("pendente")}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                {t(TYPE_LABEL[p.type])} · {t("proposta")} {when}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{p.content}</p>
            </div>
            {!p.applied_at && !readOnly ? (
              <Button
                size="sm"
                variant="outline"
                disabled={apply.isPending}
                onClick={() => void handleApply(p)}
              >
                {p.type === "org_memory_entry" ? t("Aplicar como memória da org") : t("Aplicar como versão nova")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
