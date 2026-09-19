"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { CreatedProspectingAgent } from "./_create-agent";

type PreviewResult = {
  final_text?: string | null;
  status: string;
  stub?: boolean;
  impediments?: { code: string; message: string }[];
  restrictions?: string[];
  guardrails?: {
    passou: boolean;
    termos: string[];
    naoAvaliados: { gate: string; porque: string }[];
  };
};

export function AgentPreview({
  prepare,
  disabled,
  onBusy,
}: {
  prepare: () => Promise<CreatedProspectingAgent>;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [agent, setAgent] = useState<CreatedProspectingAgent | null>(null);
  const [pending, setPending] = useState<"prepare" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  async function test() {
    if (disabled || !input.trim() || submitting.current) return;
    submitting.current = true;
    onBusy(true);
    setPending("prepare");
    setError(null);
    setResult(null);
    try {
      const prepared = await prepare();
      if (!mounted.current) return;
      setAgent(prepared);
      const abort = new AbortController();
      controller.current = abort;
      setPending("test");
      const response = await apiClient.post<{ data: PreviewResult }>(
        `/api/v1/ai/agents/${prepared.agent.id}/versions/${prepared.version_id}/test`,
        { sample_message: input.trim() },
        { timeoutMs: 120_000, signal: abort.signal },
      );
      if (mounted.current && !abort.signal.aborted) setResult(response.data);
    } catch (cause) {
      if (mounted.current)
        setError(
          controller.current?.signal.aborted
            ? t("A espera foi interrompida. O teste já enviado pode continuar no provedor.")
            : cause instanceof Error
              ? cause.message
              : t("Não foi possível testar o agente."),
        );
    } finally {
      controller.current = null;
      submitting.current = false;
      if (mounted.current) {
        setPending(null);
      }
      onBusy(false);
    }
  }

  return (
    <section aria-label={t("Testar como cliente")} className="space-y-4 p-4">
      <div>
        <h3 className="font-semibold">{t("Experimente a conversa antes de publicar")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Escreva como um cliente. O teste usa um rascunho pausado e consome créditos de IA, sem enviar mensagens aos seus contatos.",
          )}
        </p>
      </div>
      <Label htmlFor="agent-preview-message">{t("Mensagem do cliente para o teste")}</Label>
      <Textarea
        id="agent-preview-message"
        value={input}
        maxLength={4000}
        rows={3}
        disabled={!!pending || disabled}
        onChange={(event) => setInput(event.target.value)}
        placeholder={t("Tenho interesse, mas preciso entender como isso ajudaria minha empresa.")}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!!pending || disabled || !input.trim()}
          onClick={() => void test()}
        >
          {pending === "prepare"
            ? t("Preparando rascunho…")
            : pending === "test"
              ? t("Testando resposta…")
              : t("Testar resposta")}
        </Button>
        {pending === "test" && (
          <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
            {t("Parar de esperar")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div
          className="space-y-3 rounded-xl border bg-muted/30 p-4 text-sm"
          aria-label={t("Resultado da simulação")}
        >
          <p className="font-medium">{t("Resposta de teste")}</p>
          <p className="whitespace-pre-wrap">
            {result.final_text || t("O agente não produziu uma resposta para esta mensagem.")}
          </p>
          {result.stub && (
            <p>
              {t("Resposta de um provedor de teste controlado; nenhuma IA externa foi chamada.")}
            </p>
          )}
          {result.impediments?.map((item, index) => (
            <p key={`${item.code}:${index}`} className="text-destructive">
              {item.message}
            </p>
          ))}
          {result.guardrails && !result.guardrails.passou && (
            <p className="text-destructive">
              {t("Revise a resposta: ela contém termos internos do sistema.")}{" "}
              {result.guardrails.termos.join(", ")}
            </p>
          )}
          {!!result.guardrails?.naoAvaliados.length && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {t("Verificações que dependem de uma conversa real")}
              </summary>
              <ul className="mt-2 space-y-1">
                {result.guardrails.naoAvaliados.map((item) => (
                  <li key={item.gate}>{item.porque}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              "Cada teste avalia uma mensagem. Ações sobre contatos e envios não são executados nesta simulação.",
            )}
          </p>
        </div>
      )}
      {agent && (
        <Link
          className="block text-sm underline"
          href={`/app/ai/agents/${agent.agent.id}#voice-assistant`}
        >
          {t("Configurar assistente de voz neste rascunho")}
        </Link>
      )}
    </section>
  );
}
