"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useTeamInvites, type TeamInvite } from "@/hooks/team/useTeamInvites";
import { useResendInvite } from "@/hooks/team/useResendInvite";
import { useRevokeInvite } from "@/hooks/team/useRevokeInvite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowsClockwise, Copy, DotsThree, Warning } from "@/lib/ui/icons";
import { copyToClipboard } from "@/lib/clipboard";
import type { StatusConvite } from "@/lib/team/convite-status";

interface Props {
  /** admin: mostra as ações de reenviar/revogar. Manager só lê. */
  canManage: boolean;
}

const BADGE_VARIANT: Record<StatusConvite, "default" | "outline" | "secondary" | "destructive"> = {
  aceito: "default",
  pendente: "outline",
  expirado: "secondary",
  revogado: "destructive",
};

export function TeamInvitesClient({ canManage }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data, isLoading, isError } = useTeamInvites();
  const resend = useResendInvite();
  const revoke = useRevokeInvite();

  const [revokeDialog, setRevokeDialog] = useState<TeamInvite | null>(null);

  const STATUS_LABEL: Record<StatusConvite, string> = {
    aceito: t("Aceito"),
    pendente: t("Pendente"),
    expirado: t("Expirado"),
    revogado: t("Revogado"),
  };

  async function copyLink(url: string) {
    // Helper do repo (funciona em http://IP, self-host sem TLS), nunca a API crua.
    if (await copyToClipboard(url)) toast.success(t("Link do convite copiado."));
    else toast.error(t("Não foi possível copiar. Copie da barra do navegador."));
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }
  if (isError) {
    return <p className="text-sm text-destructive">{t("Erro ao carregar convites.")}</p>;
  }
  const invites = data?.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t("Convites")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Convites enviados e seu status. Um convite aceito vira membro na lista acima.")}
        </p>
      </div>

      {invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum convite enviado.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("E-mail")}</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>{t("Interface")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("E-mail enviado")}</TableHead>
                <TableHead>{t("Enviado em")}</TableHead>
                <TableHead>{t("Expira em")}</TableHead>
                <TableHead>{t("Convidado por")}</TableHead>
                {canManage ? <TableHead className="w-[60px]" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((inv) => {
                const emAberto = inv.status === "pendente" || inv.status === "expirado";
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inv.role}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {inv.interface_settings?.destinos
                        ? t("Personalizada")
                        : inv.interface_settings?.preset === "simplificada"
                          ? t("Simplificada")
                          : t("Completa")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={BADGE_VARIANT[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      {inv.email_dispatched ? (
                        <span className="text-sm text-muted-foreground">{t("Sim")}</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1 text-sm text-destructive">
                            <Warning size={14} weight="fill" />
                            {t("Não saiu")}
                          </span>
                          {emAberto && inv.accept_url ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-fit gap-1 text-xs"
                              onClick={() => copyLink(inv.accept_url!)}
                            >
                              <Copy size={13} />
                              {t("Copiar link")}
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(inv.last_sent_at).toLocaleString(tagDoIdioma)}
                      {inv.resend_count > 0 ? (
                        <span className="ml-1 text-xs">
                          ({t("reenviado")} {inv.resend_count}×)
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {inv.status === "aceito"
                        ? "—"
                        : new Date(inv.expires_at).toLocaleString(tagDoIdioma)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {inv.inviter_name ?? "—"}
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        {emAberto ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={t("Ações")}>
                                <DotsThree size={20} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={resend.isPending}
                                onClick={async () => {
                                  try {
                                    await resend.mutateAsync(inv.id);
                                    toast.success(t("Convite reenviado."));
                                  } catch {
                                    /* showApiError já disparou */
                                  }
                                }}
                              >
                                <ArrowsClockwise size={16} />
                                {t("Reenviar")}
                              </DropdownMenuItem>
                              {inv.accept_url ? (
                                <DropdownMenuItem onClick={() => copyLink(inv.accept_url!)}>
                                  <Copy size={16} />
                                  {t("Copiar link")}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setRevokeDialog(inv)}
                              >
                                {t("Revogar")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!revokeDialog} onOpenChange={(o) => !o && setRevokeDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Revogar convite")}</DialogTitle>
            <DialogDescription>
              {revokeDialog?.email}{" "}
              {t(
                "não poderá mais usar este convite para entrar. Você pode enviar um novo depois.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeDialog(null)}>
              {t("Cancelar")}
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={async () => {
                if (!revokeDialog) return;
                try {
                  await revoke.mutateAsync(revokeDialog.id);
                  toast.success(t("Convite revogado."));
                  setRevokeDialog(null);
                } catch {
                  /* showApiError já disparou */
                }
              }}
            >
              {t("Revogar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
