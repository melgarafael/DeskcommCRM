"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
import { contarDadosParaLimparDaOrganizacao } from "@/app/actions/settings/contarDadosParaLimparDaOrganizacao";
import type { ContagensApagadas } from "@/lib/settings/apagar-dados-operacionais";
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
  // O rótulo de cada tipo na prévia, na ordem em que a tela os lista. Cada texto
  // passa por t() como literal (a cerca de i18n não aceita t() sobre parâmetro).
  const linhasDaPrevia: ReadonlyArray<readonly [keyof ContagensApagadas, string]> = [
    ["messages", t("mensagens")],
    ["conversations", t("conversas")],
    ["contacts", t("contatos")],
    ["crm_leads", t("negócios")],
    ["crm_proposals", t("propostas")],
    ["orders", t("pedidos")],
    ["calendar_appointments", t("agendamentos")],
    ["companies", t("empresas")],
    ["people", t("pessoas")],
    ["import_batches", t("importações")],
  ];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [isPending, startTransition] = useTransition();
  // A22: a contagem do que vai sumir, lida ao abrir o diálogo. `null` = ainda
  // lendo; `"erro"` = não consegui contar (a tela não inventa zero).
  const [previa, setPrevia] = useState<ContagensApagadas | "erro" | null>(null);

  useEffect(() => {
    if (!open) return;
    let ativo = true;
    void contarDadosParaLimparDaOrganizacao()
      .then((r) => {
        if (ativo) setPrevia(r.ok ? r.counts : "erro");
      })
      .catch(() => {
        if (ativo) setPrevia("erro");
      });
    return () => {
      ativo = false;
    };
  }, [open]);

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
          `${t("Dados apagados")}: ${c.messages} ${t("mensagens")}, ${c.conversations} ${t("conversas")}, ${c.crm_leads} ${t("negócios")}, ${c.contacts} ${t("contatos")}, ${c.companies} ${t("empresas")}, ${c.people} ${t("pessoas")}.`,
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
          {t("Limpar dados de teste")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Apaga de vez as mensagens, conversas, negócios, contatos, agendamentos, pedidos, empresas, pessoas e importações desta organização. Serve para entregar o CRM configurado e limpo, depois de testar.",
          )}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Continuam de pé: as pessoas da equipe, as configurações, os funis e etapas, os agentes de IA, os canais de WhatsApp já conectados e o registro de auditoria.",
          )}
        </p>
      </div>

      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) setPrevia(null); // abrir de novo recontando: a base muda entre uma abertura e outra
          if (!v) setDigitado("");
        }}
      >
        <AlertDialogTrigger asChild>
          <Button type="button" variant="destructive" data-testid="abrir-zona-de-perigo">
            {t("Limpar dados de teste")}
          </Button>
        </AlertDialogTrigger>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Limpar os dados de teste?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Esta ação é irreversível. Todos os dados de atendimento de",
              )}{" "}
              <strong>{displayName}</strong> {t("serão apagados de vez, sejam de teste ou não.")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* A22: o que vai sumir, contado agora, e o aviso de backup. */}
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="previa-da-limpeza">
            <p className="font-medium">{t("Vão ser apagados:")}</p>
            {previa === null ? (
              <p className="text-muted-foreground">{t("Contando…")}</p>
            ) : previa === "erro" ? (
              <p className="text-muted-foreground">{t("Não consegui contar agora. Você ainda pode apagar.")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {linhasDaPrevia.map(([chave, rotulo]) => (
                  <li key={chave} className="flex justify-between">
                    <span>{rotulo}</span>
                    <span className="tabular-nums">{previa[chave]}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground">
              {t("Se você ainda precisa de algum desses dados, faça um backup antes de continuar.")}
            </p>
          </div>

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
