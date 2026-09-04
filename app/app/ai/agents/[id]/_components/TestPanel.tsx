"use client";
/**
 * TestPanel — dry-run de uma version (S-13.12).
 *
 * Envia sample message via POST `:test` (admin-only). Renderiza trace +
 * "Mensagem que SERIA enviada". Não toca WAHA, não cria messages.outbound.
 * Quando `INTERNAL_AGENT_RUN_STUB=true` o backend devolve trace stub com
 * `stub: true`; o componente mostra um aviso amigável.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { agentRunsKey } from "@/hooks/ai/useAgentRuns";
import { useT } from "@/hooks/i18n/useT";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

import { RunTrace } from "./RunTrace";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  readOnly?: boolean;
}

interface TestResponse {
  data: {
    run_id: string;
    status: string;
    final_text?: string | null;
    tool_calls?: unknown;
    tokens_in?: number;
    tokens_out?: number;
    cost_cents?: number;
    latency_ms?: number;
    would_send_to?: { session?: string | null; chat_id?: string | null };
    stub?: boolean;
    /** Ver lib/ai/agents/avaliar-resposta-de-teste.ts. */
    guardrails?: {
      passou: boolean;
      categorias: string[];
      termos: string[];
      naoAvaliados: Array<{ gate: string; porque: string }>;
    };
  };
}

/**
 * O que as verificações disseram sobre a resposta — e o que elas NÃO puderam
 * dizer.
 *
 * Antes disto, o teste mostrava a resposta e mais nada: nenhum gate a examinava
 * (o runtime desta tela não importa a cadeia), então o usuário publicava achando
 * que tinha visto o comportamento real. Mostrar "não verificado" em voz alta é o
 * conserto — silêncio que parece aprovação foi o defeito.
 */
function Verificacoes({ g }: { g: NonNullable<TestResponse["data"]["guardrails"]> }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="teste-verificacoes">
      {g.passou ? (
        <p
          data-testid="teste-vazamento-limpo"
          className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs"
        >
          {t("A resposta não usa palavras internas do sistema.")}
        </p>
      ) : (
        <div
          data-testid="teste-vazamento-achado"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
        >
          <p className="font-medium text-destructive">
            {t("Esta resposta usa palavras que o cliente não deveria ver.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Em produção ela seria barrada e o assistente teria que reescrever. Encontrado:")}{" "}
            <span className="font-mono">{g.termos.join(", ")}</span>
          </p>
        </div>
      )}

      {/*
        A lista do que NÃO foi checado. Ela é o que separa este conserto de uma
        mentira mais bonita: as verificações que dependem do turno real não podem
        ser avaliadas aqui, e inventá-las daria um veredito com aparência de
        prova. O usuário precisa saber a diferença entre "passou em tudo" e
        "passou no que dava para checar sem uma conversa de verdade".

        (O texto dizia "os seis gates" enquanto a lista renderizava nove — número
        que já foi verdade para um subconjunto e envelheceu. A contagem agora sai
        da própria lista, logo abaixo, e não de prosa.)

        Esta lista responde "o que este teste NÃO checou"; a aba "Confere antes de
        enviar" responde "o que é checado, e o que cada uma protege". São
        perguntas diferentes, e por isso há um ponteiro em vez de uma cópia — as
        duas saem da mesma cadeia, cada uma com o seu teste de casamento.
      */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer" data-testid="teste-nao-verificado">
          {t("O teste não consegue verificar tudo (")}
          {g.naoAvaliados.length} {t("verificações ficam de fora)")}
        </summary>
        <ul className="mt-2 space-y-1 pl-4">
          {g.naoAvaliados.map((n) => (
            <li key={n.gate}>— {n.porque}</li>
          ))}
        </ul>
        <p className="mt-2">
          {t(
            "Estas só acontecem numa conversa real, com um cliente de verdade do outro lado. Para ver a lista inteira do que é conferido — e o que cada verificação protege — abra a aba",
          )}{" "}
          <span className="font-medium text-foreground">{t("Confere antes de enviar")}</span>.
        </p>
      </details>
    </div>
  );
}

export function TestPanel({ agent, draft, published, readOnly }: Props) {
  const t = useT();
  const target = draft ?? published;
  const qc = useQueryClient();

  const [message, setMessage] = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [contactPhone, setContactPhone] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<TestResponse["data"] | null>(null);

  if (!target) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Configure e salve uma versão antes de testar.")}
      </p>
    );
  }

  const versionLabel =
    target.status === "published"
      ? `v${target.version_number} ${t("(publicada)")}`
      : `v${target.version_number} ${t("(rascunho)")}`;

  async function handleRun() {
    if (!message.trim()) {
      toast.error(t("Informe uma mensagem de teste."));
      return;
    }
    if (!target) return;
    setPending(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = { sample_message: message.trim() };
      if (contactName.trim() || contactPhone.trim()) {
        body.sample_contact = {
          ...(contactName.trim() ? { name: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { phone: contactPhone.trim() } : {}),
        };
      }
      const res = await apiClient.post<TestResponse>(
        `/api/v1/ai/agents/${agent.id}/versions/${target.id}/test`,
        body,
      );
      setResult(res.data);
      qc.invalidateQueries({ queryKey: agentRunsKey(agent.id) });
      toast.success(t("Teste executado."));
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(t(err.message) || `${t("Erro")}: ${err.code}`);
      } else {
        toast.error(t("Erro inesperado."));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Versão alvo")}
          </p>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline">{versionLabel}</Badge>
            <span className="font-mono text-xs">
              {target.provider} / {target.model}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {t("⚠ Modo teste consome créditos do provider.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Nenhuma mensagem é enviada via WhatsApp. O run é registrado como dry-run.")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-message">{t("Mensagem do cliente (sample)")}</Label>
          <Textarea
            id="test-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("Oi, quanto custa X?")}
            rows={4}
            disabled={pending || readOnly}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="test-name">{t("Nome (opcional)")}</Label>
            <Input
              id="test-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Maria"
              disabled={pending || readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="test-phone">{t("Telefone (opcional)")}</Label>
            <Input
              id="test-phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+55..."
              disabled={pending || readOnly}
            />
          </div>
        </div>

        <Button onClick={handleRun} disabled={pending || readOnly} className="self-start">
          {pending ? t("Executando…") : t("Executar teste")}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Resultado")}
        </p>

        {!result && !pending ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhum teste executado ainda.")}
          </p>
        ) : null}

        {pending ? (
          <p className="text-sm text-muted-foreground">{t("Executando dry-run…")}</p>
        ) : null}

        {result ? (
          <>
            {result.stub ? (
              <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
                {t("Stub: o runtime real é entregue na S-13.08. O trace abaixo é simulado.")}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label={t("Status")}>{result.status}</Cell>
              <Cell label={t("Latência")}>
                {typeof result.latency_ms === "number" ? `${result.latency_ms}ms` : "—"}
              </Cell>
              <Cell label={t("Tokens in/out")}>
                {(result.tokens_in ?? 0).toLocaleString()} /{" "}
                {(result.tokens_out ?? 0).toLocaleString()}
              </Cell>
              <Cell label={t("Custo (cents)")}>{result.cost_cents ?? 0}</Cell>
            </div>

            <RunTrace
              toolCalls={result.tool_calls}
              finalText={result.final_text ?? null}
              emptyMessage={t("Sem tool calls (resposta direta do LLM).")}
            />

            {result.guardrails ? <Verificacoes g={result.guardrails} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono">{children}</p>
    </div>
  );
}
