"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { ensureNotifyServiceWorker } from "@/lib/notifications/service_worker";
import { estadoDoApp, type AmbienteDoAparelho } from "@/lib/pwa/estado-da-instalacao";
import { pedirInstalacao, usePedidoDeInstalacao } from "@/lib/pwa/pedido-de-instalacao";

type Aparelho = Omit<AmbienteDoAparelho, "temPedido">;

interface NavegadorComExtras {
  readonly standalone?: boolean;
  readonly userAgentData?: { readonly mobile?: boolean };
}

/** Lido depois de montar: o servidor não conhece aparelho, navegador nem endereço. */
async function lerAparelho(): Promise<Aparelho> {
  const seguro = window.isSecureContext;
  // Registrar é também a prova: https com certificado não reconhecido recusa.
  const registro = seguro ? await ensureNotifyServiceWorker() : null;
  const extras = navigator as Navigator & NavegadorComExtras;
  return {
    seguro,
    swOk: registro !== null,
    standalone: window.matchMedia("(display-mode: standalone)").matches || extras.standalone === true,
    ua: navigator.userAgent,
    plataforma: navigator.platform,
    toques: navigator.maxTouchPoints,
    celularPelaDica: extras.userAgentData?.mobile === true,
    dedo: window.matchMedia("(pointer: coarse)").matches,
  };
}

function Caixa({ estado, children }: { estado: string; children: ReactNode }) {
  return (
    <Card data-testid={`app-${estado}`} className="flex flex-col gap-3 p-4 text-sm">
      {children}
    </Card>
  );
}

export function AplicativoNoCelular() {
  const t = useT();
  const temPedido = usePedidoDeInstalacao();
  const [aparelho, setAparelho] = useState<Aparelho | null>(null);

  useEffect(() => {
    let vivo = true;
    void lerAparelho().then((lido) => {
      if (vivo) setAparelho(lido);
    });
    return () => {
      vivo = false;
    };
  }, []);

  if (!aparelho) return null;
  const estado = estadoDoApp({ ...aparelho, temPedido });
  const avisos = (
    <Link
      href="/app/settings/notifications"
      className="inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline"
    >
      {t("Ligar os avisos em Notificações")}
    </Link>
  );

  switch (estado) {
    case "sem-https":
      return (
        <Caixa estado={estado}>
          <p className="font-medium">{t("Esta instalação não tem app no celular.")}</p>
          <p className="text-muted-foreground">
            {t(
              "O endereço não usa conexão segura (https), e sem ela nenhum navegador instala o app nem entrega aviso com o app fechado. Quem administra o servidor pode ligar um domínio com https.",
            )}
          </p>
        </Caixa>
      );
    case "sem-sw":
      return (
        <Caixa estado={estado}>
          <p className="font-medium">{t("Este navegador não conseguiu preparar o app neste endereço.")}</p>
          <p className="text-muted-foreground">
            {t("Se o sistema acabou de ser atualizado, espere um pouco e recarregue a página.")}
          </p>
          <p className="text-muted-foreground">
            {t(
              "Isso acontece no modo privado e quando o certificado de segurança do endereço não é reconhecido. Abra o endereço no Chrome ou no Safari, fora do modo privado; se continuar, quem administra o servidor precisa de um certificado válido.",
            )}
          </p>
        </Caixa>
      );
    case "instalado":
      return (
        <Caixa estado={estado}>
          <p className="font-medium">{t("Você já está usando o app.")}</p>
          {avisos}
        </Caixa>
      );
    case "iphone-embutido":
    case "android-embutido":
      return (
        <Caixa estado={estado}>
          <p className="font-medium">
            {t("Este navegador, aberto de dentro de outro aplicativo, não instala o app.")}
          </p>
          <p className="text-muted-foreground">
            {estado === "iphone-embutido"
              ? t("Toque no menu (⋯) e escolha Abrir no Safari. Depois, volte a esta tela.")
              : t("Toque no menu (⋮) e escolha Abrir no Chrome. Depois, volte a esta tela.")}
          </p>
        </Caixa>
      );
    case "iphone":
    case "iphone-outro-navegador":
      return (
        <Caixa estado={estado}>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              {estado === "iphone"
                ? t("Toque em Compartilhar, na barra do Safari.")
                : t("Toque em Compartilhar, no menu ou na barra de endereço do navegador.")}
            </li>
            <li>{t("Escolha Adicionar à Tela de Início.")}</li>
            <li>{t("Abra pelo ícone novo, entre de novo com seu e-mail e senha e ligue os avisos em Notificações.")}</li>
          </ol>
          <p className="text-muted-foreground">
            {t("No iPhone, os avisos só funcionam no app aberto pela tela de início, com iOS 16.4 ou mais novo.")}
          </p>
          {estado === "iphone" && (
            <p className="text-muted-foreground">
              {t(
                "Não achou a opção? Se o link foi aberto por outro aplicativo (como o WhatsApp), toque em Abrir no Safari e repita.",
              )}
            </p>
          )}
        </Caixa>
      );
    case "android-botao":
      return (
        <Caixa estado={estado}>
          <p>{t("Instale o app para abrir pelo ícone e receber os avisos.")}</p>
          <Button size="lg" className="self-start" onClick={() => void pedirInstalacao()}>
            {t("Instalar app")}
          </Button>
          {avisos}
        </Caixa>
      );
    case "android-menu":
      return (
        <Caixa estado={estado}>
          <p>{t("No menu do navegador (⋮), toque em Instalar app ou Adicionar à tela inicial.")}</p>
          <p className="text-muted-foreground">
            {t("Depois, abra pelo ícone novo e ligue os avisos em Notificações.")}
          </p>
          <p className="text-muted-foreground">
            {t(
              "Não achou a opção? Se o link foi aberto por outro aplicativo (como o WhatsApp), toque no menu (⋮), escolha Abrir no Chrome e repita.",
            )}
          </p>
        </Caixa>
      );
    case "outro":
      return (
        <Caixa estado={estado}>
          <p>
            {t(
              "Abra este endereço no celular. No computador, Chrome e Edge instalam pelo ícone na barra de endereço.",
            )}
          </p>
        </Caixa>
      );
  }
}
