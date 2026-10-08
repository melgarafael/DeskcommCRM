"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDeleteTenant } from "@/hooks/useDeleteTenant";
import type { TenantCounts } from "@/hooks/useTenantDetail";
import { useT } from "@/hooks/i18n/useT";

interface DeleteTenantDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  slug: string;
  displayName: string;
  counts: TenantCounts;
}

/**
 * A exclusão DEFINITIVA de um tenant. Três travas na tela, espelhando as do
 * servidor: o tenant já está suspenso (o botão só existe nesse estado), o admin
 * digita o identificador exato e escreve o motivo. A tela diz o que some, o que
 * fica e que não há volta — não "tem certeza?".
 */
export function DeleteTenantDialog({
  open,
  onClose,
  organizationId,
  slug,
  displayName,
  counts,
}: DeleteTenantDialogProps) {
  const t = useT();
  const router = useRouter();
  const [confirmacao, setConfirmacao] = useState("");
  const [motivo, setMotivo] = useState("");
  const excluir = useDeleteTenant();

  const confere = confirmacao.trim() === slug;
  const motivoOk = motivo.trim().length >= 10;

  function fechar() {
    if (excluir.isPending) return;
    setConfirmacao("");
    setMotivo("");
    onClose();
  }

  function confirmar() {
    excluir.mutate(
      { id: organizationId, confirmacao: confirmacao.trim(), motivo: motivo.trim() },
      {
        onSuccess: (res) => {
          const r = res.data;
          const falhasExternas =
            r.canais.filter((c) => c.desfecho === "falhou").length +
            (r.voz === "falhou" ? 1 : 0) +
            (r.nuvemshop === "falhou" ? 1 : 0);
          toast.success(t("Tenant excluído."), {
            description: [
              `${t("Logins removidos")}: ${r.usuarios.removidos.length}`,
              `${t("Logins mantidos (pertencem a outra empresa ou são referenciados)")}: ${r.usuarios.mantidos.length}`,
              `${t("Arquivos removidos")}: ${r.arquivos.removidos}/${r.arquivos.encontrados}`,
              falhasExternas > 0
                ? `${t("Integrações externas que não responderam")}: ${falhasExternas}`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
            duration: 15_000,
          });
          router.push("/admin/tenants");
        },
        onError: (err: Error) => {
          toast.error(t("A exclusão não foi concluída"), { description: err.message });
        },
      },
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(aberto) => {
        if (!aberto) fechar();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir tenant definitivamente")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p className="font-medium text-destructive">
                {t("Esta ação é irreversível. Não há como recuperar o tenant depois.")}
              </p>
              <p>
                {t("Serão apagados")}: {counts.user_count} {t("vínculos de usuário")},{" "}
                {counts.conversations_count} {t("conversas")}, {counts.messages_count}{" "}
                {t("mensagens")}, {counts.leads_count} {t("leads")}{" "}
                {t("e todos os demais dados de")} <strong>{displayName}</strong>{" "}
                {t(
                  "— arquivos, agentes, integrações e configurações. As sessões de WhatsApp são desconectadas.",
                )}
              </p>
              <p>
                {t(
                  "Ficam guardados: o registro de auditoria da exclusão e o resumo dos pedidos LGPD atendidos. Logins que só pertenciam a este tenant são removidos; quem participa de outra empresa continua.",
                )}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="delete-reason">
              {t("Motivo da exclusão")}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({motivo.length}/500)
              </span>
            </Label>
            <Textarea
              id="delete-reason"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={t("Ex.: contrato encerrado a pedido do cliente (mínimo 10 caracteres)")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">
              {t("Para confirmar, digite o identificador do tenant")}:{" "}
              <code className="rounded-md bg-muted px-1 py-0.5 text-xs">{slug}</code>
            </Label>
            <Input
              id="delete-confirm"
              value={confirmacao}
              onChange={(e) => setConfirmacao(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={confirmacao.length > 0 && !confere}
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={fechar} disabled={excluir.isPending}>
            {t("Cancelar")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={confirmar}
            disabled={!confere || !motivoOk || excluir.isPending}
          >
            {excluir.isPending ? t("Excluindo…") : t("Excluir definitivamente")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
