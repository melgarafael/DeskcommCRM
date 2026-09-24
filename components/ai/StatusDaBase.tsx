"use client";

/**
 * ESTADO DA BASE DE CONHECIMENTO + LEGENDA + TESTE DA CHAVE.
 *
 * Fecha a lacuna de quem acabou de cadastrar a chave: (1) o passo a passo de como
 * usar, (2) um botão que testa a chave de VERDADE (roda um embedding pelo mesmo
 * caminho da indexação) e (3) o estado atual — quantos materiais estão prontos,
 * quantos ainda preparando e quantos falharam. Sem isso, "está rodando?" só tinha
 * resposta no log do contêiner.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, TriangleAlert, KeyRound, HelpCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface RagStatus {
  provider: string | null;
  model: string | null;
  precisa_reindexar: boolean;
  resumo: {
    total: number;
    prontos: number;
    preparando: number;
    com_erro: number;
    parcial: number;
    sem_credencial: number;
  };
}

export function StatusDaBase() {
  const t = useT();
  const [testando, setTestando] = useState(false);

  const { data } = useQuery({
    queryKey: ["ai", "rag-embedding"],
    queryFn: async () =>
      (await apiClient.get<{ data: RagStatus }>("/api/v1/ai/rag-embedding")).data,
    // Enquanto há material sendo preparado, atualiza rápido; senão, devagar.
    refetchInterval: (q) => {
      const d = q.state.data as RagStatus | undefined;
      return d?.resumo?.preparando ? 4000 : 20000;
    },
  });

  async function testar() {
    setTestando(true);
    try {
      const res = await apiClient.post<{
        data: { ok: boolean; model?: string; dims?: number; erro?: string };
      }>("/api/v1/ai/rag-embedding/test", {});
      const d = res.data;
      if (d.ok) {
        toast.success(
          `${t("Chave OK")} — ${d.model} (${d.dims} ${t("dimensões")}).`,
        );
      } else {
        toast.error(`${t("A chave falhou:")} ${d.erro}`);
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setTestando(false);
    }
  }

  const r = data?.resumo;
  const preparando = r?.preparando ?? 0;
  const comErro = r?.com_erro ?? 0;

  return (
    <Card className="space-y-3 p-4" data-testid="status-da-base">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("Estado da base de conhecimento")}</h3>
          {r ? (
            <p className="text-xs text-text-muted" data-testid="status-da-base-resumo">
              {r.total} {t("materiais")} ·{" "}
              <span className="text-success-fg">{r.prontos} {t("prontos")}</span>
              {preparando > 0 ? (
                <>
                  {" · "}
                  <span className="text-foreground">
                    {preparando} {t("preparando")}
                  </span>
                </>
              ) : null}
              {comErro > 0 ? (
                <>
                  {" · "}
                  <span className="text-warning-fg">
                    {comErro} {t("com erro")}
                  </span>
                </>
              ) : null}
              {data?.precisa_reindexar ? (
                <>
                  {" · "}
                  <span className="text-warning-fg">
                    {t("precisa reindexar (o modelo mudou)")}
                  </span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-text-muted">{t("Carregando…")}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {preparando > 0 ? (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t("preparando o material…")}
            </span>
          ) : r && comErro === 0 && r.prontos > 0 ? (
            <span className="flex items-center gap-1 text-xs text-success-fg">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              {t("tudo pronto")}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={testar}
            disabled={testando}
            data-testid="status-da-base-testar"
          >
            <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden />
            {testando ? t("Testando…") : t("Testar a chave")}
          </Button>
        </div>
      </div>

      {comErro > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-warning-fg">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t(
            "Alguns materiais falharam ao preparar. Clique em “Preparar tudo de novo” — se for cota do provedor (limite por minuto), a reindexação agora respeita o ritmo.",
          )}
        </p>
      ) : null}

      <details className="text-xs text-text-muted">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-foreground">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden />
          {t("Como configurar a base (passo a passo)")}
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>{t("Escolha o provedor de embeddings (Google Gemini é o recomendado e tem chave gratuita).")}</li>
          <li>{t("Clique em “Obter uma chave…” e crie/copie a chave no site do provedor.")}</li>
          <li>{t("Cole a chave e clique em “Salvar chave”. A validação leva alguns segundos.")}</li>
          <li>{t("Clique em “Testar a chave” para confirmar que ela funciona de verdade.")}</li>
          <li>{t("Clique em “Preparar tudo de novo” no acervo — ele prepara primeiro o que falta e depois o que mudou; o que não mudou é pulado.")}</li>
        </ol>
        <p className="mt-2">
          {t(
            "Observação: no plano gratuito do Google, a indexação respeita o limite de requisições por minuto automaticamente — pode demorar, mas conclui sozinha.",
          )}
        </p>
      </details>
    </Card>
  );
}
