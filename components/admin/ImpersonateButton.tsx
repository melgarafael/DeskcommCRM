"use client";
/**
 * ImpersonateButton (S-11.07)
 *
 * Triggers `POST /api/v1/admin/tenants/[id]/impersonate`. Confirmation is
 * mandatory — the body of the dialog spells out that every subsequent action
 * will be flagged with `acting_as_platform_admin=true` in the audit log.
 *
 * On success: pushes the user to the redirect_url returned by the API
 * (default `/app/inbox`) so they immediately enter the tenant context.
 */
import { useState } from "react";
import { flushSync } from "react-dom";
import { useOrganizationTransition } from "@/components/shell/OrganizationTransitionProvider";
import { notifySupportTransition } from "@/components/app/ImpersonateBanner";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

interface ImpersonateButtonProps {
  organizationId: string;
  displayName: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function ImpersonateButton({
  organizationId,
  displayName,
  disabled,
  disabledReason,
}: ImpersonateButtonProps) {
  const t = useT();
  const transition = useOrganizationTransition();
  const [readonly, setReadonly] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    flushSync(() => { setBusy(true); transition.begin("Carregando acompanhamento…"); });
    try {
      const res = await fetch(
        `/api/v1/admin/tenants/${organizationId}/impersonate`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_mode: readonly ? "support_readonly" : "full" }) },
      );
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const rawMsg = (json as { error?: { message?: string } })?.error?.message;
        const errorMsg = rawMsg ? t(rawMsg) : t("Não foi possível iniciar impersonate");
        transition.cancel();
        toast.error(errorMsg);
        return;
      }
      const redirectUrl =
        (json as { data?: { redirect_url?: string } })?.data?.redirect_url ??
        "/app/inbox";
      setOpen(false);
      // Hard navigation so the new cookie is sent on the next request and the
      // server layout can read it to render the banner.
      notifySupportTransition();
      window.location.assign(redirectUrl);
      // Fallback (in case assign is intercepted in tests).

    } catch (err) {
      transition.cancel();
      toast.error(t("Erro de rede ao iniciar impersonate"));
      console.error("[impersonate] start error", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          className="w-full"
          variant="outline"
          disabled={disabled}
          aria-label={
            disabled
              ? (disabledReason ?? t("Impersonate indisponível"))
              : `${t("Acompanhar")} ${displayName}`
          }
          title={disabled ? disabledReason : undefined}
        >
          {t("Acompanhar organização")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Iniciar acompanhamento?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Acompanhe")} <span className="font-semibold text-foreground">{displayName}</span> {t("com sua identidade de administrador. As ações pelo aplicativo serão registradas em seu nome. O acesso dura até uma hora.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={readonly} onChange={e => setReadonly(e.target.checked)} />{t("Somente leitura")}</label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={busy}>
            {busy ? t("Entrando…") : t("Confirmar e entrar")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
