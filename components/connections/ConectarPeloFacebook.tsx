"use client";
/**
 * «Conectar com o Facebook» — a janela da Meta (Embedded Signup) com o app da
 * PRÓPRIA instalação (#4074).
 *
 * A Meta devolve o resultado por DOIS canais, em ordem que não é garantida:
 * - o `code` chega no callback do `FB.login`;
 * - o número e a conta chegam numa `postMessage` (`WA_EMBEDDED_SIGNUP`) vinda da
 *   janela, de uma origem `*.facebook.com`.
 * O envio ao servidor só acontece quando os dois chegaram, e uma vez só.
 *
 * Nada de segredo passa por aqui: App ID e Configuration ID são públicos, e o
 * `code` só vale trocado no servidor junto do App Secret.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConnectOfficialEmbeddedSignup } from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import { lerMensagemDoEmbeddedSignup, type ModoDaConexao } from "@/lib/channels/meta/sessao-do-embedded-signup";

interface FacebookSdk {
  init(opcoes: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(
    callback: (resposta: { authResponse?: { code?: string } | null; status?: string }) => void,
    opcoes: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const ID_DO_SCRIPT = "facebook-jssdk";

/** Carrega o SDK do Facebook uma vez e o inicia com o app da instalação. */
function carregarSdk(appId: string, versao: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    const iniciar = () => {
      if (!window.FB) return reject(new Error("sdk_indisponivel"));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: versao });
      resolve(window.FB);
    };
    if (window.FB) return iniciar();
    window.fbAsyncInit = iniciar;
    if (document.getElementById(ID_DO_SCRIPT)) return;
    const script = document.createElement("script");
    script.id = ID_DO_SCRIPT;
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("sdk_bloqueado"));
    document.body.appendChild(script);
  });
}

export function ConectarPeloFacebook({
  appId,
  configId,
  graphVersion,
  conectado,
}: {
  appId: string;
  configId: string;
  graphVersion: string;
  conectado: boolean;
}) {
  const t = useT();
  const conectar = useConnectOfficialEmbeddedSignup();
  const [abrindo, setAbrindo] = useState(false);
  const codigo = useRef<string | null>(null);
  const sessao = useRef<{ phone_number_id?: string; waba_id: string; modo: ModoDaConexao } | null>(null);
  const enviado = useRef(false);

  const tentarEnviar = useCallback(async () => {
    if (enviado.current || !codigo.current || !sessao.current) return;
    enviado.current = true;
    try {
      const r = await conectar.mutateAsync({ code: codigo.current, ...sessao.current });
      toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
    } catch {
      // O toast de erro já vem do `onError` do hook.
    } finally {
      codigo.current = null;
      sessao.current = null;
      setAbrindo(false);
    }
  }, [conectar, t]);

  useEffect(() => {
    function aoReceber(evento: MessageEvent) {
      const leitura = lerMensagemDoEmbeddedSignup(evento.origin, evento.data);
      if (leitura.tipo === "ignorar") return;
      if (leitura.tipo === "cancelado") {
        toast.info(t("A conexão pelo Facebook foi cancelada antes do fim."));
        setAbrindo(false);
        return;
      }
      if (leitura.tipo === "erro") {
        toast.error(`${t("A Meta recusou a conexão:")} ${leitura.mensagem}`.trim());
        setAbrindo(false);
        return;
      }
      const { tipo: _tipo, ...dadosDaSessao } = leitura;
      sessao.current = dadosDaSessao;
      void tentarEnviar();
    }
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, [t, tentarEnviar]);

  async function abrir() {
    setAbrindo(true);
    enviado.current = false;
    codigo.current = null;
    sessao.current = null;
    let fb: FacebookSdk;
    try {
      fb = await carregarSdk(appId, graphVersion);
    } catch {
      toast.error(t("Não deu para abrir a janela do Facebook. Libere pop-ups e bloqueadores para este site e tente de novo."));
      setAbrindo(false);
      return;
    }
    // O callback do FB.login não pode ser `async` (a Meta recusa a função).
    fb.login(
      (resposta) => {
        const code = resposta.authResponse?.code;
        if (!code) {
          // Janela fechada sem concluir. A mensagem CANCEL, quando vem, já avisou.
          setAbrindo(false);
          return;
        }
        codigo.current = code;
        void tentarEnviar();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
      },
    );
  }

  const ocupado = abrindo || conectar.isPending;

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="conectar-pelo-facebook">
      <div>
        <h2 className="font-medium">
          {conectado ? t("Trocar o número pelo Facebook") : t("Conectar com o Facebook")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Abre a janela oficial da Meta: entre com o Facebook da empresa, escolha (ou cadastre) o número e confirme. O CRM recebe a conexão sozinho — sem copiar token nem IDs.")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Já usa o número no app WhatsApp Business? Escolha esse número na janela: o app continua funcionando e as conversas passam a chegar também aqui.")}
        </p>
      </div>
      <div>
        <Button type="button" onClick={() => void abrir()} disabled={ocupado} data-testid="btn-conectar-facebook">
          {conectar.isPending
            ? t("Conectando com a Meta…")
            : abrindo
              ? t("Aguardando a janela do Facebook…")
              : t("Conectar com o Facebook")}
        </Button>
      </div>
    </Card>
  );
}
