"use client";
import { useState, useTransition } from "react";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RecoveryCodesPanel } from "@/components/auth/RecoveryCodesPanel";
import { MfaEnrollModal } from "@/components/auth/MfaEnrollModal";
import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";
import { signOutEverywhere } from "@/app/actions/settings/signOutEverywhere";
import {
  definirExigenciaDeMfa,
  desativarMfaDaConta,
} from "@/app/actions/auth/politicaDeMfa";
import { PainelDeChamadaDeVoz } from "@/components/voice/PainelDeChamadaDeVoz";
import { useT } from "@/hooks/i18n/useT";

export function SecurityClient({
  mfaEnrolled,
  obrigatorio,
  podeExigirDaEquipe,
  empresaExige,
}: {
  mfaEnrolled: boolean;
  /** A política obriga esta pessoa a ter a verificação? */
  obrigatorio: boolean;
  /** Só admin muda a regra da empresa. */
  podeExigirDaEquipe: boolean;
  empresaExige: boolean;
}) {
  const t = useT();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isSigningOut, startSignOut] = useTransition();
  const [ativando, setAtivando] = useState(false);
  const [mexendo, startMexer] = useTransition();
  const [confirmRegenerar, setConfirmRegenerar] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmDesligarMfa, setConfirmDesligarMfa] = useState(false);

  function handleRegenerate() {
    startTransition(async () => {
      const r = await regenerateRecoveryCodes();
      if (r.ok) {
        setCodes(r.recovery_codes);
        toast.success(t("Novos códigos gerados."));
      } else {
        toast.error(`${t("Erro:")} ${r.error}`);
      }
    });
  }

  function handleSignOutAll() {
    startSignOut(async () => {
      await signOutEverywhere();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* O modal é o MESMO do bloqueador de tela cheia — reusado, não copiado.
          Ele recarrega a página ao terminar, e o servidor reavalia o estado. */}
      {ativando ? <MfaEnrollModal motivo="escolha" /> : null}

      <Card className="space-y-3 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">{t("Verificação em duas etapas")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Além da senha, o sistema pede um código de 6 dígitos que só existe no seu celular. É a proteção que segura uma senha vazada.",
              )}
            </p>
          </div>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 text-xs " +
              (mfaEnrolled
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-muted text-muted-foreground")
            }
          >
            {mfaEnrolled ? t("Ativada") : t("Desativada")}
          </span>
        </div>

        {mfaEnrolled ? (
          <div className="space-y-2">
            {obrigatorio ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ela é obrigatória para administradores desta empresa, então não dá para desligar aqui. Um administrador pode mudar essa regra abaixo.",
                )}
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={mexendo}
                onClick={() => setConfirmDesligarMfa(true)}
              >
                {mexendo ? t("Desligando…") : t("Desligar")}
              </Button>
            )}
          </div>
        ) : (
          <Button size="sm" onClick={() => setAtivando(true)}>
            {t("Ativar")}
          </Button>
        )}
      </Card>

      {podeExigirDaEquipe ? (
        <Card className="space-y-3 p-6">
          <h2 className="text-sm font-semibold">{t("Exigir de quem administra")}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={empresaExige}
              disabled={mexendo}
              onChange={(e) => {
                const marcar = e.target.checked;
                startMexer(async () => {
                  const r = await definirExigenciaDeMfa(marcar);
                  if (!r.ok) {
                    toast.error(t(r.erro));
                    return;
                  }
                  toast.success(
                    marcar
                      ? t("Agora os administradores precisam da verificação.")
                      : t("A verificação deixou de ser obrigatória."),
                  );
                  window.location.reload();
                });
              }}
            />
            <span>
              {t(
                "Todo administrador desta empresa precisa configurar a verificação em duas etapas.",
              )}
              <span className="mt-1 block text-xs text-muted-foreground">
                {t(
                  "Quando ligado, quem administra vê uma tela pedindo a configuração antes de usar o sistema. Ligue se a sua equipe mexe com dados de clientes — é a diferença entre uma senha vazada virar um susto ou virar um vazamento.",
                )}
              </span>
            </span>
          </label>
        </Card>
      ) : null}

      <Card className="space-y-3 p-6">
        <h2 className="text-sm font-semibold">{t("Códigos de recuperação")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Use se perder acesso ao autenticador. Cada código é de uso único.")}
        </p>
        {codes ? (
          <RecoveryCodesPanel codes={codes} onAcknowledge={() => setCodes(null)} />
        ) : (
          <Button
            variant="outline"
            disabled={!mfaEnrolled || isPending}
            onClick={() => setConfirmRegenerar(true)}
          >
            {isPending ? t("Gerando…") : t("Regenerar códigos de recuperação")}
          </Button>
        )}
        {!mfaEnrolled && (
          <p className="text-xs text-muted-foreground">
            {t("Habilite MFA antes de gerar códigos.")}
          </p>
        )}
      </Card>

      {/* Chamada de voz: a outra decisão de RISCO da organização que vive
          nesta tela. Ele mesmo decide se aparece — some quando a instalação
          não tem a feature ou quem lê não pode enxergá-la. */}
      <PainelDeChamadaDeVoz />

      <Card className="space-y-3 p-6">
        <h2 className="text-sm font-semibold">{t("Sessões ativas")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Listagem de sessões — em breve. Por enquanto, deslogue todos os dispositivos:")}
        </p>
        <Button
          variant="outline"
          disabled={isSigningOut}
          onClick={() => setConfirmSignOut(true)}
        >
          {isSigningOut ? t("Saindo…") : t("Sair de todos os dispositivos")}
        </Button>
      </Card>

      <AlertDialog open={confirmRegenerar} onOpenChange={setConfirmRegenerar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Gerar novos códigos de recuperação?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Os códigos atuais são invalidados imediatamente.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRegenerate}>
              {t("Confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Sair de todos os dispositivos?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Você precisará fazer login de novo em cada um deles.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSignOutAll}>
              {t("Confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDesligarMfa} onOpenChange={setConfirmDesligarMfa}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desligar a verificação em duas etapas?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Sua conta fica sem essa camada de proteção até você ativar de novo.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                startMexer(async () => {
                  const r = await desativarMfaDaConta();
                  if (!r.ok) {
                    toast.error(t(r.erro));
                    return;
                  }
                  toast.success(t("Verificação desligada."));
                  window.location.reload();
                });
              }}
            >
              {t("Desligar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
