"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SuspendDialog } from "./SuspendDialog";
import { ReactivateDialog } from "./ReactivateDialog";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";
import { useT } from "@/hooks/i18n/useT";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantActionsProps {
  organizationId: string;
  status: "active" | "suspended" | "redacted";
  suspendedKind?: TipoDeSuspensao | null;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantActions({
  organizationId,
  status,
  suspendedKind,
  displayName,
}: TenantActionsProps) {
  const t = useT();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const canSuspend = status === "active";
  const isSuspended = status === "suspended";
  const isRedacted = status === "redacted";
  const suspensaPorCobranca = isSuspended && suspendedKind === "cobranca";

  return (
    <>
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t("Ações")}
        </h2>

        {/* Impersonate (S-11.07) */}
        <ImpersonateButton
          organizationId={organizationId}
          displayName={displayName}
          disabled={isRedacted}
          disabledReason={
            isRedacted ? t("Tenant redigido — ação não disponível") : undefined
          }
        />

        {/* Suspend */}
        {canSuspend && (
          <Button
            className="w-full"
            variant="destructive"
            onClick={() => setSuspendOpen(true)}
            aria-label={t("Suspender tenant")}
          >
            {t("Suspender tenant")}
          </Button>
        )}

        {/* O tipo da suspensão (D-6, spec da cobrança §9). A de cobrança sai pelo
            card Cobrança (Dar prazo / Tornar isenta); a rota /reactivate a recusa
            com `suspensao_de_cobranca`, então o botão genérico some para ela. */}
        {isSuspended && (
          <p data-testid="tipo-da-suspensao" className="text-sm font-medium">
            {suspensaPorCobranca ? t("Suspensa por falta de pagamento") : t("Suspensão administrativa")}
          </p>
        )}
        {suspensaPorCobranca && (
          <p className="text-xs text-muted-foreground">
            {t("Para reativar, use o card Cobrança: Dar prazo ou Tornar isenta.")}
          </p>
        )}

        {/* Reactivate — só a administrativa */}
        {isSuspended && !suspensaPorCobranca && (
          <Button
            className="w-full"
            variant="outline"
            onClick={() => setReactivateOpen(true)}
            aria-label={t("Reativar tenant")}
          >
            {t("Reativar tenant")}
          </Button>
        )}

        {isRedacted && (
          <p className="text-xs text-muted-foreground text-center py-2">
            {t("Tenant redigido — ações de gestão não disponíveis.")}
          </p>
        )}
      </div>

      <SuspendDialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        organizationId={organizationId}
      />

      <ReactivateDialog
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        organizationId={organizationId}
      />
    </>
  );
}
