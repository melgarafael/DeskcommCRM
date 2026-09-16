"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FlowArrow, Plus } from "@/lib/ui/icons";
import { useFollowupFlows, type FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { DeleteFollowupFlowButton } from "./DeleteFollowupFlowButton";
import { FlowStatusBadge } from "./FlowStatusBadge";
import { NewFlowDialog } from "./NewFlowDialog";

interface Props {
  initialData: FollowupFlowPointerRow[];
  canWrite: boolean;
  /** Recorte por superfície. Ausente = todos (comportamento atual). */
  surface?: FollowupFlowSurface;
}

function formatUpdatedAt(iso: string, idioma: string): string {
  return new Date(iso).toLocaleDateString(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function FlowsList({ initialData, canWrite, surface }: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data } = useFollowupFlows({ initialData, ...(surface ? { surface } : {}) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const deAtendimento = surface === "atendimento";

  const flows = data ?? [];
  // Cada superfície tem a SUA rota de editor: abrir um fluxo de atendimento não
  // pode jogar o usuário na lista de Follow-ups.
  const baseHref = deAtendimento ? "/app/ai/atendimento" : "/app/ai/followups";

  const newFlowButton = (
    <Button onClick={() => setDialogOpen(true)} className="w-full sm:w-auto">
      <Plus size={14} aria-hidden className="mr-2" />
      {deAtendimento ? t("Novo fluxo de atendimento") : t("Novo fluxo")}
    </Button>
  );

  if (flows.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">
            {deAtendimento ? t("Nenhum fluxo de atendimento ainda") : t("Nenhum fluxo de follow-up ainda")}
          </h2>
          <p className="max-w-sm text-sm text-text-muted">
            {deAtendimento
              ? t(
                  "Os fluxos de atendimento cadastram as perguntas que a IA faz durante a conversa e o que acontece ao concluir — os dados ficam guardados por cliente.",
                )
              : t(
                  "Follow-ups reengajam contatos após silêncio, mudança de etapa, uma regra em Webhooks ou a resposta do contato — sem depender de alguém lembrar de mandar mensagem.",
                )}
          </p>
          {canWrite && <div className="mt-1">{newFlowButton}</div>}
        </Card>
        {canWrite && <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} surface={surface} />}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div className="flex sm:justify-end">{newFlowButton}</div>
      )}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {flows.map((flow) => (
          <li key={flow.id}>
            <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-accent-400">
              <Link href={`${baseHref}/${flow.id}`} className="flex flex-1 flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1 truncate font-medium" title={flow.name}>
                    {flow.name}
                  </h3>
                  <FlowStatusBadge status={flow.status} />
                </div>
                <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
                  <div>
                    <dt className="text-text-muted">{t("Versão")}</dt>
                    <dd className="font-mono">{flow.active_version_id ? "publicada" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Handoff</dt>
                    <dd className="font-mono">{flow.handoff_policy}</dd>
                  </div>
                </dl>
                <p className="mt-auto pt-2 text-xs text-text-muted">
                  Atualizado em {formatUpdatedAt(flow.updated_at, tagDoIdioma)}
                </p>
              </Link>
              {canWrite && (
                <div className="flex justify-end border-t border-border pt-2">
                  <DeleteFollowupFlowButton flowId={flow.id} flowName={flow.name} listHref={baseHref} />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {canWrite && <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} surface={surface} />}
    </div>
  );
}
