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
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/admin/tenants/${organizationId}/impersonate`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const rawMsg = (json as { error?: { message?: string } })?.error?.message;
        const errorMsg = rawMsg ? t(rawMsg) : t("Não foi possível iniciar impersonate");
        toast.error(errorMsg);
        return;
      }
      const redirectUrl =
        (json as { data?: { redirect_url?: string } })?.data?.redirect_url ??
        "/app/inbox";
      setOpen(false);
      // Hard navigation so the new cookie is sent on the next request and the
      // server layout can read it to render the banner.
      window.location.assign(redirectUrl);
      // Fallback (in case assign is intercepted in tests).
      router.push(redirectUrl);
    } catch (err) {
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
              : `${t("Impersonar")} ${displayName}`
          }
          title={disabled ? disabledReason : undefined}
        >
          {t("Impersonar tenant")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Iniciar impersonate?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Você está prestes a entrar como o tenant")}{" "}
            <span className="font-semibold text-foreground">{displayName}</span>.{" "}
            {t("Toda ação será registrada com a flag")}{" "}
            <code className="rounded-md bg-muted px-1 py-0.5 text-xs">
              acting_as_platform_admin
            </code>
            . {t("A sessão expira em 1 hora. Confirma?")}
          </AlertDialogDescription>
        </AlertDialogHeader>
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
