"use client";

import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { DownloadSimple, X } from "@/lib/ui/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function BotaoInstalarApp() {
  const t = useT();
  const [promptInstall, setPromptInstall] = useState<BeforeInstallPromptEvent | null>(null);
  const [jaInstalado, setJaInstalado] = useState(true);
  const [dialogIosAberto, setDialogIosAberto] = useState(false);
  const [ehIos, setEhIos] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Detecta se já está rodando em tela cheia / standalone (app instalado)
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    setJaInstalado(isStandalone);
    if (isStandalone) return;

    // Detecta iOS
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
    setEhIos(isIosDevice);

    const handler = (e: Event) => {
      e.preventDefault();
      setPromptInstall(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  if (jaInstalado) return null;

  // Se não for iOS e o navegador ainda não disparou o prompt, não mostra
  if (!promptInstall && !ehIos) return null;

  const handleInstalar = async () => {
    if (ehIos) {
      setDialogIosAberto(true);
      return;
    }

    if (promptInstall) {
      await promptInstall.prompt();
      const choice = await promptInstall.userChoice;
      if (choice.outcome === "accepted") {
        setJaInstalado(true);
      }
      setPromptInstall(null);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleInstalar}
        className="h-8 gap-1.5 border-primary/30 bg-primary/5 px-2.5 text-xs font-medium text-primary hover:bg-primary/10"
        title={t("Instalar aplicativo no celular ou computador")}
      >
        <DownloadSimple size={15} weight="bold" />
        <span>{t("Instalar App")}</span>
      </Button>

      {/* Modal explicativo para Safari no iPhone/iPad */}
      <Dialog open={dialogIosAberto} onOpenChange={setDialogIosAberto}>
        <DialogContent className="max-w-xs sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {t("Instalar no iPhone / iPad")}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t("Use o sistema em tela cheia e com máxima velocidade.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-xs">
            <div className="flex items-start gap-2.5 rounded-md bg-muted/50 p-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                1
              </span>
              <p>
                {t("Toque no botão de")} <strong>{t("Compartilhar")}</strong> {t("na barra inferior do Safari.")}
              </p>
            </div>
            <div className="flex items-start gap-2.5 rounded-md bg-muted/50 p-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                2
              </span>
              <p>
                {t("Role para baixo e selecione")} <strong>{t("Adicionar à Tela de Início")}</strong>.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setDialogIosAberto(false)}>
            {t("Entendi")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
