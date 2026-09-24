"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FlowArrow, Plus, Sparkle } from "@/lib/ui/icons";
import { useFollowupFlows, type FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { DeleteFollowupFlowButton } from "./DeleteFollowupFlowButton";
import { DuplicateFollowupFlowButton } from "./DuplicateFollowupFlowButton";
import { FlowStatusBadge } from "./FlowStatusBadge";
import { ModelosDialog } from "./ModelosDialog";
import { NewFlowDialog } from "./NewFlowDialog";
import { RenameFollowupFlowButton } from "./RenameFollowupFlowButton";

interface Props {
  initialData: FollowupFlowPointerRow[];
  canWrite: boolean;
}

function formatUpdatedAt(iso: string, idioma: string): string {
  return new Date(iso).toLocaleDateString(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function FlowsList({ initialData, canWrite }: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data } = useFollowupFlows({ initialData });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [modelosOpen, setModelosOpen] = useState(false);

  const flows = data ?? [];

  // ⚠️ "Começar de um modelo" vem ANTES de "Novo fluxo", e na tela vazia é o
  // botão cheio. Quem chega aqui numa instalação nova não sabe o que é nó, ramo
  // ou prazo de graça — mandá-lo para uma tela em branco é o caminho mais curto
  // para a clínica nunca ter follow-up nenhum. Desenhar do zero continua a um
  // clique, para quem já sabe o que quer.
  const modelosButton = (
    <Button onClick={() => setModelosOpen(true)} className="w-full sm:w-auto">
      <Sparkle size={14} aria-hidden className="mr-2" /> {t("Começar de um modelo")}
    </Button>
  );

  const newFlowButton = (
    <Button onClick={() => setDialogOpen(true)} variant="outline" className="w-full sm:w-auto">
      <Plus size={14} aria-hidden className="mr-2" /> Novo fluxo
    </Button>
  );

  const dialogos = canWrite && (
    <>
      <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ModelosDialog
        open={modelosOpen}
        onOpenChange={setModelosOpen}
        nomesExistentes={flows.map((f) => f.name)}
      />
    </>
  );

  if (flows.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">{t("Nenhum fluxo de follow-up ainda")}</h2>
          <p className="max-w-sm text-sm text-text-muted">
            {t(
              "Follow-ups reengajam contatos após silêncio, mudança de etapa, uma regra em Webhooks ou a resposta do contato — sem depender de alguém lembrar de mandar mensagem.",
            )}
          </p>
          {canWrite && (
            <div className="mt-1 flex flex-col items-center gap-2 sm:flex-row">
              {modelosButton}
              {newFlowButton}
            </div>
          )}
        </Card>
        {dialogos}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          {modelosButton}
          {newFlowButton}
        </div>
      )}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {flows.map((flow) => (
          <li key={flow.id}>
            <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-accent-400">
              <Link href={`/app/ai/followups/${flow.id}`} className="flex flex-1 flex-col gap-3">
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
                <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-2">
                  <RenameFollowupFlowButton flowId={flow.id} flowName={flow.name} />
                  <DuplicateFollowupFlowButton flowId={flow.id} />
                  <DeleteFollowupFlowButton flowId={flow.id} flowName={flow.name} />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {dialogos}
    </div>
  );
}
