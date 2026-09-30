"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SuspendDialog } from "./SuspendDialog";
import { ReactivateDialog } from "./ReactivateDialog";
import { DeleteTenantDialog } from "./DeleteTenantDialog";
import { EditTenantDialog } from "./EditTenantDialog";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";
import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantActionsProps {
  organization: TenantOrganization;
  counts: TenantCounts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * O ciclo de vida do tenant, na ordem em que ele acontece: editar → suspender
 * ⇄ reativar → excluir. Excluir só existe para o tenant JÁ SUSPENSO — a
 * suspensão é a primeira metade da decisão (reversível) e deixa o tenant parado
 * antes de sumir; o servidor recusa a exclusão de um tenant ativo do mesmo jeito.
 */
export function TenantActions({ organization, counts }: TenantActionsProps) {
  const t = useT();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { id: organizationId, status, display_name: displayName } = organization;
  const canSuspend = status === "active";
  const isSuspended = status === "suspended";
  const isRedacted = status === "redacted";

  return (
    <>
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t("Ações")}
        </h2>

        {/* Impersonate (S-11.07) — o acompanhamento só vale para tenant ativo. */}
        <ImpersonateButton
          organizationId={organizationId}
          displayName={displayName}
          disabled={!canSuspend}
          disabledReason={
            isRedacted
              ? t("Tenant redigido — ação não disponível")
              : isSuspended
                ? t("Tenant suspenso — reative para acompanhar")
                : undefined
          }
        />

        {!isRedacted && (
          <Button className="w-full" variant="outline" onClick={() => setEditOpen(true)}>
            {t("Editar dados")}
          </Button>
        )}

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

        {/* Reactivate */}
        {isSuspended && (
          <Button
            className="w-full"
            variant="outline"
            onClick={() => setReactivateOpen(true)}
            aria-label={t("Reativar tenant")}
          >
            {t("Reativar tenant")}
          </Button>
        )}

        {/* Delete — só depois de suspenso */}
        {isSuspended && (
          <Button
            className="w-full"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            aria-label={t("Excluir tenant")}
          >
            {t("Excluir tenant")}
          </Button>
        )}
        {canSuspend && (
          <p className="text-xs text-muted-foreground">
            {t("Para excluir um tenant, suspenda-o primeiro.")}
          </p>
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

      <EditTenantDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        organization={organization}
      />

      <DeleteTenantDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        organizationId={organizationId}
        slug={organization.slug}
        displayName={displayName}
        counts={counts}
      />
    </>
  );
}
