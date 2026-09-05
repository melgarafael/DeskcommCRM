"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
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
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Digite o nome da organização para confirmar.",
  unauthenticated: "Sua sessão expirou. Entre de novo para continuar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Só quem administra esta empresa pode apagar os dados.",
  mfa_required: "Confirme o código do seu aplicativo de duas etapas e tente de novo.",
  confirmacao_nao_confere: "O nome digitado não confere com o nome da organização.",
  db_error: "Não consegui apagar os dados agora.",
};

interface Props {
  readonly displayName: string;
}

export function ZonaDePerigoDaOrganizacao({ displayName }: Props) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [isPending, startTransition] = useTransition();

  const confere = digitado.trim() === displayName.trim();

  function handleConfirm() {
    if (!confere) return;
    startTransition(async () => {
      const resultado = await apagarDadosOperacionaisDaOrganizacao({
        confirmNome: digitado.trim(),
      });
      if (resultado.ok) {
        const c = resultado.counts;
        toast.success(
          `${t("Dados apagados")}: ${c.messages} ${t("mensagens")}, ${c.conversations} ${t("conversas")}, ${c.crm_leads} ${t("negócios")}, ${c.contacts} ${t("contatos")}.`,
        );
        setOpen(false);
        setDigitado("");
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui apagar os dados agora."));
    });
  }

  return (
    <Card
      data-testid="zona-de-perigo"
      className="max-w-2xl space-y-4 border-destructive/40 p-6"
    >
      <div>
        <h2 className="text-base font-semibold tracking-tight text-destructive">
          {t("Zona de perigo")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Apaga de vez as mensagens, conversas, negócios, contatos, agendamentos e pedidos desta organização. Serve para recomeçar os testes do zero antes de atender de verdade.",
          )}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Continuam de pé: as pessoas da equipe, as configurações, os funis e etapas, os agentes de IA e os canais de WhatsApp já conectados.",
          )}
        </p>
      </div>

      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setDigitado("");
        }}
      >
        <AlertDialogTrigger asChild>
          <Button type="button" variant="destructive" data-testid="abrir-zona-de-perigo">
            {t("Apagar todos os dados de atendimento")}
          </Button>
        </AlertDialogTrigger>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Apagar todos os dados de atendimento?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Esta ação é irreversível. Mensagens, conversas, negócios, contatos, agendamentos e pedidos de",
              )}{" "}
              <strong>{displayName}</strong> {t("serão apagados de vez.")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="confirm_nome_organizacao">
              {t("Digite")} <strong>{displayName}</strong> {t("para confirmar")}
            </Label>
            <Input
              id="confirm_nome_organizacao"
              data-testid="confirmar-nome-da-organizacao"
              value={digitado}
              onChange={(e) => setDigitado(e.target.value)}
              autoComplete="off"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="apagar-de-vez"
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={!confere || isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? t("Apagando…") : t("Apagar de vez")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
