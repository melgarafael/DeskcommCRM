"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useChangeMemberEmail,
  useTenantMembers,
  type MembroDoTenant,
} from "@/hooks/useTenantMembers";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DO_PAPEL, type Role } from "@/lib/auth/types";

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface TenantMembersProps {
  organizationId: string;
  /** Tenant excluído/redigido não tem o que editar. */
  readOnly?: boolean;
}

/**
 * Quem entra neste tenant, com o e-mail de LOGIN — é aqui que se corrige o
 * endereço de quem se cadastrou errado. O e-mail mora no provedor de
 * autenticação, não na empresa: por isso a troca é por pessoa.
 */
export function TenantMembers({ organizationId, readOnly = false }: TenantMembersProps) {
  const t = useT();
  const { data, isLoading, isError } = useTenantMembers(organizationId);
  const [editando, setEditando] = useState<MembroDoTenant | null>(null);

  const membros = data?.data.members ?? [];

  return (
    <div className="space-y-4 rounded-lg border bg-card p-5">
      <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
        {t("Membros e e-mails de acesso")}
      </h2>

      {isLoading && <Skeleton className="h-24 w-full" />}
      {isError && (
        <p className="text-sm text-destructive">{t("Não foi possível carregar os membros.")}</p>
      )}
      {!isLoading && !isError && membros.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("Nenhum membro neste tenant.")}</p>
      )}

      <ul className="divide-y">
        {membros.map((m) => (
          <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium" data-testid="membro-email">
                {m.email ?? t("(sem e-mail)")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="neutral">{t(ROTULO_DO_PAPEL[m.role as Role] ?? m.role)}</Badge>
                {m.is_owner && <Badge variant="info">{t("Dono")}</Badge>}
                {m.is_platform_admin && <Badge variant="default">{t("Admin da plataforma")}</Badge>}
                {m.revoked_at && <Badge variant="warning">{t("Acesso revogado")}</Badge>}
              </div>
            </div>
            {!readOnly && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditando(m)}
                disabled={m.is_platform_admin || !!m.revoked_at}
                title={
                  m.is_platform_admin
                    ? t(
                        "O e-mail de um administrador da plataforma só é trocado pelo próprio dono da conta.",
                      )
                    : m.revoked_at
                      ? t(
                          "Quem perdeu o acesso a este tenant não tem o e-mail trocado por aqui: a empresa avisada seria uma em que a pessoa já não está.",
                        )
                      : undefined
                }
              >
                {t("Alterar e-mail")}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <TrocarEmailDialog
        organizationId={organizationId}
        membro={editando}
        onClose={() => setEditando(null)}
      />
    </div>
  );
}

function TrocarEmailDialog({
  organizationId,
  membro,
  onClose,
}: {
  organizationId: string;
  membro: MembroDoTenant | null;
  onClose: () => void;
}) {
  const t = useT();
  const [email, setEmail] = useState("");
  const trocar = useChangeMemberEmail(organizationId);

  const normalizado = email.trim().toLowerCase();
  const valido = EMAIL_VALIDO.test(normalizado);
  const igual = normalizado === (membro?.email ?? "").toLowerCase();

  function fechar() {
    if (trocar.isPending) return;
    setEmail("");
    onClose();
  }

  function salvar() {
    if (!membro) return;
    trocar.mutate(
      { userId: membro.user_id, email: normalizado },
      {
        onSuccess: () => {
          toast.success(t("E-mail alterado."), {
            description: t(
              "A pessoa já entra com o novo endereço, e a recuperação de senha vai para ele. A empresa foi avisada na Central.",
            ),
          });
          setEmail("");
          onClose();
        },
        onError: (err: Error) =>
          toast.error(t("Não foi possível alterar o e-mail"), { description: err.message }),
      },
    );
  }

  return (
    <Dialog
      open={!!membro}
      onOpenChange={(aberto) => {
        if (!aberto) fechar();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Alterar e-mail de acesso")}</DialogTitle>
          <DialogDescription>
            {t(
              "O novo endereço passa a ser o login e o destino da recuperação de senha. Confirme que ele pertence mesmo a esta pessoa.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm">
            {t("E-mail atual")}: <strong>{membro?.email ?? "—"}</strong>
          </p>
          <div className="space-y-2">
            <Label htmlFor="novo-email">{t("Novo e-mail")}</Label>
            <Input
              id="novo-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              aria-invalid={email.length > 0 && !valido}
            />
            {email.length > 0 && !valido && (
              <p className="text-xs text-destructive" role="alert">
                {t("E-mail inválido")}
              </p>
            )}
            {valido && igual && (
              <p className="text-xs text-muted-foreground">
                {t("Este já é o e-mail desta pessoa.")}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={trocar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={salvar} disabled={!valido || igual || trocar.isPending}>
            {trocar.isPending ? t("Salvando…") : t("Salvar e-mail")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
