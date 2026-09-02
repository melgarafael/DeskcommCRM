"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { skipWhatsapp, markWhatsappConfigured } from "@/app/actions/onboarding/skipWhatsapp";

interface Props {
  wahaConfigured: boolean;
  sessionName: string;
}

type Status =
  | "INIT"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "STOPPED"
  | "NOT_STARTED"
  | "ERROR";

interface SessionInfo {
  status: Status;
  session: string | null;
  channel_session_id?: string;
  error?: string;
}

/**
 * Server actions throw a sentinel `NEXT_REDIRECT` when calling `redirect()`.
 * The Next runtime catches it at the boundary, but inside a try/catch we
 * must re-throw so navigation actually happens.
 */
function isRedirectError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
  );
}

/**
 * O estado do pareamento em palavras — nunca o enum do transporte.
 * Cada linha responde "e agora?", que é a pergunta de quem está olhando.
 */
function rotuloDoEstado(s: Status): string {
  switch (s) {
    case "SCAN_QR_CODE":
      return "Pronto para conectar";
    case "STARTING":
    case "INIT":
      return "A preparar o código…";
    case "WORKING":
      return "Conectado!";
    case "FAILED":
      return "O código expirou";
    default:
      return "Não consegui falar com o WhatsApp";
  }
}

function explicacaoDoEstado(s: Status): string {
  switch (s) {
    case "SCAN_QR_CODE":
      return "Digitalize o código abaixo com o telemóvel que vai atender.";
    case "STARTING":
    case "INIT":
      return "Isto leva alguns segundos. O código aparece aqui sozinho.";
    case "WORKING":
      return "O número está no ar. A seguir para o próximo passo.";
    case "FAILED":
      return "É normal — ele vale poucos minutos. É possível gerar outro.";
    default:
      return "O serviço roda no seu servidor e não respondeu agora.";
  }
}

export function ConnectWhatsappClient({ wahaConfigured, sessionName }: Props) {
  const [pending, startTransition] = useTransition();
  const [info, setInfo] = useState<SessionInfo>({ status: "INIT", session: sessionName });
  const [qrTick, setQrTick] = useState(0);
  const [busy, setBusy] = useState(false);

  const status = info.status;

  // 1) On mount (when WAHA is configured), start the session if not yet started.
  useEffect(() => {
    if (!wahaConfigured) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const res = await fetch("/api/v1/onboarding/whatsapp/session", { method: "POST" });
        const json = (await res.json()) as { data?: SessionInfo; error?: { message?: string } };
        if (cancelled) return;
        if (json.data) {
          setInfo(json.data);
          return;
        }
        // MEDIDO percorrendo o wizard com o serviço de WhatsApp fora do ar: a
        // resposta vinha 502, `json.data` era undefined, nada era gravado — e a
        // tela ficava dizendo "Preparando o código… Isso leva alguns segundos"
        // PARA SEMPRE. Uma mentira gentil é pior que um erro: a pessoa espera
        // por algo que nunca vai acontecer, e a única saída visível é pular.
        setInfo({
          status: "ERROR",
          session: sessionName,
          error: json.error?.message ?? `o servidor respondeu ${res.status}`,
        });
      } catch (err) {
        if (!cancelled) setInfo({ status: "ERROR", session: sessionName, error: String(err) });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wahaConfigured, sessionName]);

  // 2) Poll status every 3 seconds until WORKING/FAILED.
  useEffect(() => {
    if (!wahaConfigured) return;
    if (status === "WORKING" || status === "FAILED") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/v1/onboarding/whatsapp/session");
        const json = (await res.json()) as { data?: SessionInfo };
        if (json.data) {
          setInfo(json.data);
          if (json.data.status === "SCAN_QR_CODE") setQrTick((t) => t + 1);
        }
        // Falha de leitura durante a espera NÃO é transitória quando se
        // repete: sem isto, a tela seguia em "preparando" enquanto toda
        // tentativa falhava.
        if (!res.ok) {
          setInfo((antes) =>
            antes.status === "INIT" || antes.status === "STARTING"
              ? { status: "ERROR", session: sessionName, error: `o servidor respondeu ${res.status}` }
              : antes,
          );
        }
      } catch {
        setInfo((antes) =>
          antes.status === "INIT" || antes.status === "STARTING"
            ? { status: "ERROR", session: sessionName, error: "não consegui falar com o servidor" }
            : antes,
        );
      }
    }, 3000);
    return () => clearInterval(id);
  }, [wahaConfigured, status, sessionName]);

  // 3) When status → WORKING, auto-advance.
  useEffect(() => {
    if (status !== "WORKING") return;
    startTransition(async () => {
      try {
        await markWhatsappConfigured(sessionName, "WORKING");
      } catch (err) {
        if (isRedirectError(err)) throw err;
        toast.error("Falha ao avançar: " + String(err));
      }
    });
  }, [status, sessionName]);

  // Derruba a sessão morta e sobe outra. O polling volta sozinho porque `status`
  // sai de FAILED e o efeito que o observa roda de novo.
  async function restartSession() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/onboarding/whatsapp/session?restart=1", { method: "POST" });
      const json = (await res.json()) as { data?: SessionInfo };
      if (json.data) setInfo(json.data);
      else toast.error("Não consegui gerar outro código. Tente de novo em alguns segundos.");
    } catch {
      toast.error("Não consegui falar com o servidor. Confira sua conexão e tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  const showQr = wahaConfigured && status === "SCAN_QR_CODE";

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      {!wahaConfigured && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">O WhatsApp desta instalação ainda não subiu.</p>
          <p className="mt-1">
            Ele roda no seu próprio servidor. Dá para seguir sem ele agora e conectar o
            número depois, em <strong>Canais › Conexões</strong> — seu funcionário fica
            pronto de qualquer jeito, só não terá por onde atender ainda.
          </p>
        </div>
      )}

      {wahaConfigured && (
        <div className="rounded-md border bg-muted/40 p-4">
          {/*
            O que estava aqui: "Sessão: org_f3d61bc0" e "Status: INIT".
            O primeiro é um identificador que o produto deriva do id interno da
            organização — não há nada que o dono faça com ele. O segundo é o
            enum do transporte, em inglês e maiúsculas. Medido percorrendo o
            wizard: com o serviço de WhatsApp fora do ar, a tela ficava PARADA
            em "INIT", sem código, sem erro e sem próximo passo. A pessoa olha
            uma palavra que não significa nada e não sabe se espera ou desiste.
          */}
          <p className="text-sm font-medium">{rotuloDoEstado(busy ? "STARTING" : status)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{explicacaoDoEstado(busy ? "STARTING" : status)}</p>

          {status === "WORKING" && (
            <p className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              ✓ Conectado! Avançando…
            </p>
          )}

          {status === "FAILED" && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-destructive">
                O código expirou antes de alguém digitalizar. É normal — ele vale só alguns minutos.
              </p>
              <p className="text-xs text-muted-foreground">
                Deixe o WhatsApp já aberto em <strong>Dispositivos ligados</strong> antes de gerar o
                próximo, que aí sobra tempo.
              </p>
              <Button type="button" size="sm" disabled={busy} onClick={restartSession}>
                {busy ? "A gerar…" : "Gerar novo QR Code"}
              </Button>
            </div>
          )}

          {(status === "ERROR" || status === "NOT_STARTED" || status === "STOPPED") && (
            <div className="mt-3 space-y-2">
              <p className="text-sm">
                O serviço de WhatsApp desta instalação não respondeu. Ele roda no seu
                servidor, junto com o resto do sistema — quem instalou consegue religá-lo.
              </p>
              {info.error && (
                <p className="text-xs text-muted-foreground">
                  Detalhe técnico: <code className="break-all">{info.error}</code>
                </p>
              )}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={restartSession}>
                {busy ? "A tentar…" : "Tentar de novo"}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                await skipWhatsapp();
              } catch (err) {
                if (isRedirectError(err)) throw err;
                toast.error("Falha ao pular: " + String(err));
              }
            })
          }
        >
          Pular por enquanto
        </Button>
        <Button
          type="button"
          disabled={pending || status === "WORKING"}
          onClick={() =>
            startTransition(async () => {
              try {
                await markWhatsappConfigured(
                  sessionName,
                  status === "WORKING" ? "WORKING" : "configured",
                );
              } catch (err) {
                if (isRedirectError(err)) throw err;
                toast.error("Falha ao marcar passo: " + String(err));
              }
            })
          }
        >
          Conectei em outro lugar
        </Button>
      </div>
    </div>
  );
}
