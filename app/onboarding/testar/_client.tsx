"use client";

import { useState, useTransition, useRef } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { marcarTesteFeito, pularTeste } from "@/app/actions/onboarding/marcarTeste";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { ehTimeoutDeRequisicao, mensagemSeguraDeHttp, mensagemVisivelDeApiError } from "@/lib/api/erro-http";
import { OPCOES_HTTP_DO_ENSAIO, urlEnsaioDoAgente } from "@/lib/ai/agents/rota-de-ensaio";

interface Props {
  nome: string | null;
  agenteId: string | null;
  versaoId: string | null;
  /** Há versão publicada no atendimento. Sem isto o ensaio é só interno. */
  noAr: boolean;
}

/** O que o ensaio devolveu — ou por que ele não aconteceu. */
type Desfecho =
  | { tipo: "resposta"; texto: string }
  | { tipo: "erro"; mensagem: string };

const EXEMPLO = "Oi! Vocês atendem hoje? Queria saber o preço.";

export function TestarClient({ nome, agenteId, versaoId, noAr }: Props) {
  const t = useT();
  const [mensagem, setMensagem] = useState(EXEMPLO);
  const [desfecho, setDesfecho] = useState<Desfecho | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [pending, startTransition] = useTransition();
  const emVoo = useRef(false);

  const funcionario = nome ?? t("seu funcionário");

  const semAgente = !agenteId;
  const semVersao = Boolean(agenteId) && !versaoId;
  const podeEnsaiar = Boolean(agenteId && versaoId);

  async function ensaiar() {
    if (!agenteId || !versaoId) return;
    if (emVoo.current || carregando) return;
    emVoo.current = true;
    setCarregando(true);
    setDesfecho(null);
    try {
      const res = await apiClient.post<{
        data?: { final_text?: string; status?: string; error_code?: string; error_message?: string };
      }>(urlEnsaioDoAgente(agenteId, versaoId), { sample_message: mensagem }, OPCOES_HTTP_DO_ENSAIO);
      const d = res.data;
      if (d?.status && d.status !== "completed" && d.status !== "ok") {
        setDesfecho({
          tipo: "erro",
          mensagem: d.error_message ?? d.error_code ?? `${t("o ensaio terminou como")} "${d.status}"`,
        });
        return;
      }
      const texto = d?.final_text?.trim();
      setDesfecho(
        texto
          ? { tipo: "resposta", texto }
          : { tipo: "erro", mensagem: t("Ele executou, mas não devolveu texto nenhum.") },
      );
    } catch (err) {
      if (ehTimeoutDeRequisicao(err)) {
        setDesfecho({
          tipo: "erro",
          mensagem: t(
            "O teste demorou mais que o esperado. Verifique a aba Execuções antes de tentar novamente.",
          ),
        });
        return;
      }
      if (err instanceof ApiError) {
        const naoJson =
          err.details !== undefined &&
          typeof err.details === "object" &&
          "content_kind" in err.details;
        setDesfecho({
          tipo: "erro",
          mensagem: naoJson
            ? mensagemSeguraDeHttp(err.status, "executar o teste")
            : mensagemVisivelDeApiError(err, "executar o teste"),
        });
        return;
      }
      setDesfecho({
        tipo: "erro",
        mensagem: t("Não foi possível executar o teste."),
      });
    } finally {
      emVoo.current = false;
      setCarregando(false);
    }
  }

  return (
    <div className="space-y-4">
      {semAgente && (
        <div className="rounded-lg border bg-background p-6" role="status">
          <p className="text-sm font-medium">{t("Você ainda não montou seu funcionário.")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Sem ninguém treinado, não há o que testar. Dá para voltar ao passo anterior agora ou fazer isso depois, em IA › Agentes.",
            )}
          </p>
        </div>
      )}

      {semVersao && (
        <div className="rounded-lg border bg-background p-6" role="status">
          <p className="text-sm font-medium">
            {funcionario} {t("está como")} <strong>{t("rascunho")}</strong> — {t("ainda não foi para o ar.")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Abra IA › Agentes, salve o rascunho e volte aqui para ensaiar. Para atender clientes, conecte um canal.",
            )}
          </p>
        </div>
      )}

      {podeEnsaiar && (
        <div className="space-y-4 rounded-lg border bg-background p-6">
          {!noAr ? (
            <p data-testid="aviso-ensaio-sem-canal" className="text-sm text-muted-foreground" role="status">
              {funcionario} {t("está como")} <strong>{t("rascunho")}</strong>.{" "}
              {t("Você pode testar este agente aqui. Para atender clientes, conecte um canal.")}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="mensagem">{t("Escreva como se fosse um cliente")}</Label>
            <Textarea
              id="mensagem"
              value={mensagem}
              onChange={(e) => setMensagem(e.target.value)}
              rows={3}
              maxLength={4000}
            />
          </div>
          <div className="flex sm:justify-end">
            <Button
              type="button"
              onClick={ensaiar}
              disabled={carregando || mensagem.trim() === ""}
              className="w-full sm:w-auto"
            >
              {carregando ? t("Ele está pensando...") : t("Mandar mensagem")}
            </Button>
          </div>

          {desfecho?.tipo === "resposta" && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {funcionario} {t("respondeu")}
              </p>
              <p className="whitespace-pre-wrap text-sm">{desfecho.texto}</p>
              <p className="text-xs text-muted-foreground">
                {t("Esta conversa não foi enviada a ninguém e não aparece no seu inbox.")}
              </p>
            </div>
          )}

          {desfecho?.tipo === "erro" && (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/20"
            >
              <p className="text-sm font-medium">
                {t(
                  "Ele não conseguiu responder — e é melhor descobrir isso agora do que com um cliente de verdade.",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Motivo:")} <code className="break-all">{desfecho.mensagem}</code>
              </p>
              <p className="text-sm">
                {t(
                  "As causas mais comuns são a chave da empresa de IA sem saldo ou o modelo indisponível. Dá para conferir em",
                )}{" "}
                <strong>{t("IA › Credenciais")}</strong>{" "}
                {t("e seguir daqui mesmo — o que você montou está salvo.")}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => startTransition(() => void pularTeste())}
        >
          {t("Pular")}
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                await marcarTesteFeito(desfecho?.tipo === "resposta");
              } catch (err) {
                if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) throw err;
                toast.error(t("Não consegui salvar este passo."));
              }
            })
          }
        >
          {t("Continuar")}
        </Button>
      </div>
    </div>
  );
}
