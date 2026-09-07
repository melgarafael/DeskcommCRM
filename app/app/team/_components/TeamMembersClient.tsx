"use client";

import { MemberInterfaceDialog } from "@/components/team/MemberInterfaceDialog";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers, type TeamMember } from "@/hooks/team/useTeamMembers";
import { useChangeRole } from "@/hooks/team/useChangeRole";
import { useRevokeMember } from "@/hooks/team/useRevokeMember";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ROLES, type Role } from "@/lib/schemas/team";
import { DotsThree } from "@/lib/ui/icons";

interface Props {
  currentUserId: string;
  canManage: boolean;
}

export function TeamMembersClient({ currentUserId, canManage }: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data, isLoading, isError } = useTeamMembers();
  const changeRole = useChangeRole();
  const revoke = useRevokeMember();

  const [interfaceMember, setInterfaceMember] = useState<TeamMember | null>(null);
  const [revokeDialog, setRevokeDialog] = useState<TeamMember | null>(null);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }
  if (isError) {
    return <p className="text-sm text-destructive">{t("Erro ao carregar membros.")}</p>;
  }
  const members = data?.data ?? [];
  if (members.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("Nenhum membro ativo.")}</p>;
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Membro")}</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>{t("Interface")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Última atividade")}</TableHead>
              {canManage ? <TableHead className="w-[80px]" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.user_id}>
                <TableCell>
                  <div className="font-medium">
                    {m.full_name ?? m.email ?? m.user_id.slice(0, 8)}
                  </div>
                  {m.email ? <div className="text-xs text-muted-foreground">{m.email}</div> : null}
                </TableCell>
                <TableCell>
                  {canManage && m.user_id !== currentUserId ? (
                    <Select
                      value={m.role}
                      onValueChange={(v) =>
                        changeRole.mutate({ userId: m.user_id, role: v as Role })
                      }
                    >
                      <SelectTrigger
                        className="w-[130px]"
                        aria-label={`${t("Papel de")} ${m.full_name ?? m.email ?? m.user_id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary">{m.role}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${t("Interface de")} ${m.full_name ?? m.email ?? m.user_id}`}
                      onClick={() => setInterfaceMember(m)}
                    >
                      {m.interface_settings?.destinos
                        ? t("Personalizada")
                        : m.interface_settings?.preset === "simplificada"
                          ? t("Simplificada")
                          : t("Completa")}
                    </Button>
                  ) : (
                    <span>
                      {m.interface_settings?.destinos
                        ? t("Personalizada")
                        : m.interface_settings?.preset === "simplificada"
                          ? t("Simplificada")
                          : t("Completa")}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {m.accepted_at ? (
                    <Badge variant="default">{t("Aceito")}</Badge>
                  ) : (
                    <Badge variant="outline">{t("Pendente")}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {m.last_sign_in_at
                    ? new Date(m.last_sign_in_at).toLocaleString(tagDoIdioma)
                    : "—"}
                </TableCell>
                {canManage ? (
                  <TableCell>
                    {m.user_id !== currentUserId ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={t("Ações")}>
                            <DotsThree size={20} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setRevokeDialog(m)}
                          >
                            {t("Revogar acesso")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("você")}</span>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {interfaceMember && (
        <MemberInterfaceDialog
          key={interfaceMember.user_id}
          member={interfaceMember}
          onClose={() => setInterfaceMember(null)}
        />
      )}
      <Dialog open={!!revokeDialog} onOpenChange={(o) => !o && setRevokeDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Revogar acesso")}</DialogTitle>
            <DialogDescription>
              {revokeDialog?.email ?? revokeDialog?.user_id}{" "}
              {t("perderá acesso ao tenant. Esta ação pode ser desfeita reconvidando o membro.")}
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
                  await revoke.mutateAsync(revokeDialog.user_id);
                  toast.success(t("Acesso revogado."));
                  setRevokeDialog(null);
                } catch {
                  /* showApiError already triggered by the hook */
                }
              }}
            >
              {t("Revogar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
