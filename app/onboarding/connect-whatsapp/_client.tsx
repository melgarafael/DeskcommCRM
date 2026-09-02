"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { skipWhatsapp, markWhatsappConfigured } from "@/app/actions/onboarding/skipWhatsapp";
import { CanalOficialClient } from "@/components/connections/CanalOficialClient";
import { CanalParceiroClient } from "@/components/connections/CanalParceiroClient";

interface Props {
  wahaConfigured: boolean;
  sessionName: string;
  /**
   * A volta do canal oficial depende de um valor que mora no `.env` do
   * servidor, e o instalador NÃO o escreve — então numa instalação recém-feita
   * ele está ausente. Sem ele o número envia e nunca recebe, e o lugar de dizer
   * isso é ANTES de a pessoa buscar três credenciais no painel, não depois.
   */
  oficialPodeReceber: boolean;
}

/**
 * COMO a pessoa já usa o número. Vive em `useState` e NUNCA é gravada.
 *
 * Gravar aqui seria o defeito: `cumprido` do passo é `Boolean(state.whatsapp)`
 * (`lib/onboarding/passos.ts`), então persistir a escolha no clique marcaria o
 * passo como resolvido — e quem fechasse o navegador no meio cairia direto no
 * passo seguinte, sem telefone e sem caminho de volta, porque o roteador só
 * devolve o primeiro passo NÃO cumprido. O banco só é tocado quando o passo
 * termina de verdade: conectou, pulou, ou disse que já tinha conectado.
 */
type Forma = "qr" | "oficial" | "parceiro";

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
function rotuloDoEstado(s: Status, t: (texto: string) => string): string {
  switch (s) {
    case "SCAN_QR_CODE":
      return t("Pronto para conectar");
    case "STARTING":
    case "INIT":
      return t("Preparando o código…");
    case "WORKING":
      return t("Conectado!");
    case "FAILED":
      return t("O código expirou");
    default:
      return t("Não consegui falar com o WhatsApp");
  }
}

function explicacaoDoEstado(s: Status, t: (texto: string) => string): string {
  switch (s) {
    case "SCAN_QR_CODE":
      return t("Escaneie o código abaixo com o celular que vai atender.");
    case "STARTING":
    case "INIT":
      return t("Isso leva alguns segundos. O código aparece aqui sozinho.");
    case "WORKING":
      return t("O número está no ar. Seguindo para o próximo passo.");
    case "FAILED":
      return t("É normal — ele vale poucos minutos. Dá para gerar outro.");
    default:
      return t("O serviço roda no seu servidor e não respondeu agora.");
  }
}

/**
 * Um cartão de escolha — a MESMA forma que o resto do produto já usa
 * (`app/app/settings/atendimento/_form.tsx`): `<label>` embrulhando um radio
 * nativo. Não é `RadioGroup` porque esse componente não existe neste repo, e
 * trazê-lo criaria um quarto dialeto de escolha ao lado de três iguais.
 */
function Escolha({
  valor,
  atual,
  titulo,
  corpo,
  onEscolher,
}: {
  valor: Forma;
  atual: Forma | null;
  titulo: string;
  corpo: string;
  onEscolher: (v: Forma) => void;
}) {
  const marcada = atual === valor;
  return (
    <label
      data-testid={`forma-${valor}`}
      data-marcada={marcada ? "sim" : "nao"}
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        marcada ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
      }`}
    >
      <input
        type="radio"
        name="forma-de-conectar"
        value={valor}
        checked={marcada}
        onChange={() => onEscolher(valor)}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        aria-label={titulo}
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{titulo}</span>
        <span className="block text-xs text-muted-foreground">{corpo}</span>
      </span>
    </label>
  );
}

/** Voltar à pergunta. Escolher errado não pode ser uma porta que tranca. */
function VoltarParaEscolha({ onVoltar }: { onVoltar: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="voltar-para-escolha"
      onClick={onVoltar}
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      ← {t("Escolher outra forma")}
    </button>
  );
}

/**
 * As duas saídas do passo, iguais nos três ramos.
 *
 * Ficam FORA do ramo de propósito: o defeito que este projeto já pagou caro
 * (commit c2f88e83) foi um aviso correto que nasceu sem botão — quem instalava
 * sem chave ficava preso numa tela com o diagnóstico certo e nenhum caminho.
 * Aqui, nenhuma escolha — nem a pergunta em si — deixa a pessoa sem saída.
 */
function Saidas({ status, sessionName }: { status: Status; sessionName: string }) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
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
              toast.error(`${t("Falha ao pular:")} ${String(err)}`);
            }
          })
        }
      >
        {t("Pular por enquanto")}
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
              toast.error(`${t("Falha ao marcar passo:")} ${String(err)}`);
            }
          })
        }
      >
        {t("Conectei em outro lugar")}
      </Button>
    </div>
  );
}

export function ConnectWhatsappClient({
  wahaConfigured,
  sessionName,
  oficialPodeReceber,
}: Props) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const [forma, setForma] = useState<Forma | null>(null);
  const [info, setInfo] = useState<SessionInfo>({ status: "INIT", session: sessionName });
  const [qrTick, setQrTick] = useState(0);
  const [qrFailed, setQrFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = info.status;

  // 1) Sobe a sessão QUANDO A PESSOA ESCOLHE o código — não ao montar a tela.
  //
  // Era na montagem (o comentário aqui dizia "on mount, when WAHA is
  // configured"), e isso é o defeito que esta tela veio corrigir: o canal
  // nascia por código de barras só porque alguém pisou na rota, sem nunca ter
  // sido perguntado. Quem tem conta oficial já entrava pelo caminho errado
  // antes de clicar em coisa alguma, e descobria depois, em outra tela.
  useEffect(() => {
    if (forma !== "qr") return;
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
          error: json.error?.message ? t(json.error.message) : `${t("o servidor respondeu")} ${res.status}`,
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
  }, [forma, wahaConfigured, sessionName, t]);

  // 2) Poll status every 3 seconds until WORKING/FAILED.
  //
  // Também preso à escolha: sem isto, quem escolheu outra forma seguiria
  // batendo de 3 em 3 segundos numa sessão que nunca subiu — e a tela do lado
  // trocaria de estado sozinha por trás do formulário que a pessoa preenche.
  useEffect(() => {
    if (forma !== "qr") return;
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
  }, [forma, wahaConfigured, status, sessionName, t]);

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
  }, [status, sessionName, t]);

  // Derruba a sessão morta e sobe outra. O polling volta sozinho porque `status`
  // sai de FAILED e o efeito que o observa roda de novo.
  async function restartSession() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/onboarding/whatsapp/session?restart=1", { method: "POST" });
      const json = (await res.json()) as { data?: SessionInfo };
      if (json.data) setInfo(json.data);
      else toast.error(t("Não consegui gerar outro código. Tente de novo em alguns segundos."));
    } catch {
      toast.error(t("Não consegui falar com o servidor. Confira sua conexão e tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  const showQr = wahaConfigured && status === "SCAN_QR_CODE";

  // A PERGUNTA. Enquanto ninguém respondeu, nada é criado e nada é pedido —
  // é o único estado em que esta tela não tem efeito colateral nenhum.
  if (forma === null) {
    return (
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("Como você já usa esse número?")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "Existe mais de um jeito de ter WhatsApp para empresa, e cada um conecta de um jeito. Se você nunca ouviu falar dos outros dois, é o primeiro.",
            )}
          </p>
          <div className="grid gap-2">
            <Escolha
              valor="qr"
              atual={forma}
              titulo={t("Leio um código com o celular")}
              corpo={t(
                "É assim para quase todo mundo. Você abre o WhatsApp no celular que vai atender e aponta para um código que aparece aqui.",
              )}
              onEscolher={setForma}
            />
            <Escolha
              valor="oficial"
              atual={forma}
              titulo={t("Tenho conta oficial na Meta")}
              corpo={t("Você cadastrou o número na Meta e tem as credenciais em mãos. Não usa o celular para conectar.")}
              onEscolher={setForma}
            />
            <Escolha
              valor="parceiro"
              atual={forma}
              titulo={t("Contrato de um provedor parceiro")}
              corpo={t("Uma empresa parceira cuida do seu WhatsApp e te deu uma chave de acesso.")}
              onEscolher={setForma}
            />
          </div>
        </fieldset>
        <Saidas status={status} sessionName={sessionName} />
      </div>
    );
  }

  if (forma === "oficial" || forma === "parceiro") {
    return (
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <VoltarParaEscolha onVoltar={() => setForma(null)} />

        {forma === "oficial" && !oficialPodeReceber && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">
              {t("Este servidor ainda não está pronto para RECEBER por este caminho.")}
            </p>
            <p className="mt-1">
              {t(
                "Dá para conectar e já enviar, mas as respostas do cliente não vão chegar até quem instalou o sistema completar uma configuração no servidor. Se você quer atender hoje, o caminho do código com o celular funciona agora — e dá para trocar depois, sem perder nada.",
              )}
            </p>
          </div>
        )}

        {/* Os mesmos componentes da tela de Conexões, inteiros. Reescrevê-los
            aqui criaria uma segunda cópia de um formulário que valida credencial
            contra o outro lado ANTES de gravar — e duas cópias divergem. */}
        {forma === "oficial" ? <CanalOficialClient /> : <CanalParceiroClient />}

        <Saidas status={status} sessionName={sessionName} />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      <VoltarParaEscolha onVoltar={() => setForma(null)} />
      {!wahaConfigured && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{t("O WhatsApp desta instalação ainda não subiu.")}</p>
          <p className="mt-1">
            {t("Ele roda no seu próprio servidor. Dá para seguir sem ele agora e conectar o número depois, em")}{" "}
            <strong>{t("Canais › Conexões")}</strong> —{" "}
            {t("seu funcionário fica pronto de qualquer jeito, só não terá por onde atender ainda.")}
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
          <p className="text-sm font-medium">{rotuloDoEstado(busy ? "STARTING" : status, t)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{explicacaoDoEstado(busy ? "STARTING" : status, t)}</p>

          {/*
            O CÓDIGO EM SI. `showQr` já existia calculado (e o `qrTick` já era
            mantido, incrementado a cada resposta SCAN_QR_CODE do polling,
            especificamente para isto) — só faltava a tag que os usasse. O
            texto acima dizia "Escaneie o código abaixo" para um "abaixo" que
            não existia, e nenhum teste e2e passa por este estado (o
            `wizard-do-funcionario.spec.ts` pula o WhatsApp), então o buraco
            não aparecia em CI.

            `/api/v1/onboarding/whatsapp/qr` é a rota que já fazia o proxy da
            imagem do WAHA (existia, sem consumidor). `qrTick` na query invalida
            o cache do navegador a cada novo código — sem ele, a mesma URL não
            recarregaria a imagem quando o WAHA girasse o QR por trás.
          */}
          {showQr && (
            <div className="mt-3 flex flex-col items-center gap-2">
              {qrFailed ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Não consegui carregar o código agora. Ele deve reaparecer sozinho em instantes — se não aparecer, gere outro abaixo.",
                  )}
                </p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={qrTick}
                  src={`/api/v1/onboarding/whatsapp/qr?t=${qrTick}`}
                  alt={t("Código QR para conectar o WhatsApp")}
                  className="h-48 w-48 rounded-md border bg-white object-contain sm:h-56 sm:w-56"
                  onError={() => setQrFailed(true)}
                  onLoad={() => setQrFailed(false)}
                />
              )}
            </div>
          )}

          {showQr && (
            <div className="mt-3 flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- vem de rota proxy, muda a cada poll */}
              <img
                src={`/api/v1/onboarding/whatsapp/qr?t=${qrTick}`}
                alt="Código para digitalizar com o WhatsApp"
                width={220}
                height={220}
                className="rounded-md border bg-white p-2"
              />
            </div>
          )}

          {status === "WORKING" && (
            <p className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              ✓ {t("Conectado! Avançando…")}
            </p>
          )}

          {status === "FAILED" && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-destructive">
                {t("O código expirou antes de alguém escanear. É normal — ele vale só alguns minutos.")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Deixe o WhatsApp já aberto em")} <strong>{t("Aparelhos conectados")}</strong>{" "}
                {t("antes de gerar o próximo, que aí dá tempo de sobra.")}
              </p>
              <Button type="button" size="sm" disabled={busy} onClick={restartSession}>
                {busy ? t("Gerando…") : t("Gerar novo QR Code")}
              </Button>
            </div>
          )}

          {(status === "ERROR" || status === "NOT_STARTED" || status === "STOPPED") && (
            <div className="mt-3 space-y-2">
              <p className="text-sm">
                {t(
                  "O serviço de WhatsApp desta instalação não respondeu. Ele roda no seu servidor, junto com o resto do sistema — quem instalou consegue religá-lo.",
                )}
              </p>
              {info.error && (
                <p className="text-xs text-muted-foreground">
                  {t("Detalhe técnico:")} <code className="break-all">{info.error}</code>
                </p>
              )}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={restartSession}>
                {busy ? t("Tentando…") : t("Tentar de novo")}
              </Button>
            </div>
          )}
        </div>
      )}

      <Saidas status={status} sessionName={sessionName} />
    </div>
  );
}
