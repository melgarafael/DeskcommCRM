"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { FonteDoFeedNaTela } from "@/lib/catalogo/fonte-do-feed";

interface PlanoConferido {
  criar: number;
  atualizar: number;
  desativar: number;
  inalterados: number;
  erros: number;
  /** A trava da desativação recusou a rodada: "Sincronizar" fica desligado. */
  recusa: string | null;
}

/**
 * CATÁLOGO POR FEED — a seção que o módulo `catalogo_por_feed` acende na tela de
 * Produtos (#3587, PR #4179 de @webtecnica; doc 322, A). Só existe com o módulo
 * ligado: `page.tsx` nem lê a fonte quando ele está desligado.
 *
 * Duas coisas, nesta ordem: o ESTADO da sincronização (a última leitura, o que
 * ela fez e, quando falha seguido, o motivo) e, para quem pode mudar preço, o
 * endereço do feed com "Conferir" antes de "Sincronizar" — a rodada mexe no
 * preço que o atendente de IA responde, então olhar antes é o caminho do botão.
 */
export function FonteDoFeed({ fonte, podeEditar }: { fonte: FonteDoFeedNaTela | null; podeEditar: boolean }) {
  const t = useT();
  const router = useRouter();
  const [url, setUrl] = React.useState(fonte?.url ?? "");
  const [formato, setFormato] = React.useState<"json" | "csv">(fonte?.formato ?? "json");
  const [conferido, setConferido] = React.useState<PlanoConferido | null>(null);
  const [ocupado, setOcupado] = React.useState(false);

  async function enviar(dryRun: boolean) {
    setOcupado(true);
    try {
      const corpo = await apiClient.post<{ data: { resumo: Omit<PlanoConferido, "recusa">; recusa?: string | null } }>(
        "/api/v1/products/feed",
        { url: url.trim(), formato, dry_run: dryRun },
      );
      if (dryRun) {
        setConferido({ ...corpo.data.resumo, recusa: corpo.data.recusa ?? null });
      } else {
        setConferido(null);
        toast.success(t("Catálogo sincronizado com o feed."));
        router.refresh();
      }
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className="mb-6 rounded-lg border p-4 text-sm" data-testid="fonte-do-feed">
      <h2 className="font-medium">{t("Catálogo por feed")}</h2>
      <p className="mt-1 text-muted-foreground">
        {t(
          "O sistema de estoque da revenda publica a lista de produtos num endereço, e o catálogo acompanha sozinho a cada 2 horas. Produto que sai do feed é desativado, nunca apagado.",
        )}
      </p>

      {fonte ? (
        <div className="mt-3 space-y-1" data-testid="estado-do-feed">
          <p className="break-all">
            <span className="text-muted-foreground">{t("Endereço:")}</span> {fonte.url}
          </p>
          <p>
            <span className="text-muted-foreground">{t("Última leitura:")}</span>{" "}
            {fonte.ultimaLeitura ?? t("ainda não leu")}
          </p>
          {fonte.resumo ? (
            <p data-testid="resumo-do-feed">
              {fonte.resumo.criados} {t("novos")} · {fonte.resumo.atualizados} {t("atualizados")} ·{" "}
              {fonte.resumo.desativados} {t("desativados")} · {fonte.resumo.erros} {t("com erro")}
            </p>
          ) : null}
          {fonte.falhasSeguidas > 0 ? (
            <p className="rounded-md bg-destructive/10 p-2 text-destructive" role="alert" data-testid="falha-do-feed">
              {t("A leitura do feed falhou {n} vez(es) seguida(s). Nada foi desativado por causa disso.").replace(
                "{n}",
                String(fonte.falhasSeguidas),
              )}{" "}
              {fonte.ultimoErro ? `${t("Último motivo:")} ${fonte.ultimoErro}` : null}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-muted-foreground" data-testid="sem-feed">
          {t("Nenhum feed cadastrado nesta empresa.")}
        </p>
      )}

      {podeEditar ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setConferido(null);
            }}
            placeholder="https://"
            aria-label={t("Endereço do feed")}
            className="h-9 w-full max-w-md rounded-md border px-3"
            data-testid="url-do-feed"
          />
          <select
            value={formato}
            onChange={(e) => {
              setFormato(e.target.value === "csv" ? "csv" : "json");
              setConferido(null);
            }}
            aria-label={t("Formato do feed")}
            className="h-9 rounded-md border px-2"
            data-testid="formato-do-feed"
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
          <Button
            variant="outline"
            disabled={ocupado || url.trim() === ""}
            onClick={() => void enviar(true)}
            data-testid="conferir-feed"
          >
            {t("Conferir")}
          </Button>
          <Button disabled={ocupado || conferido === null || conferido.recusa !== null} onClick={() => void enviar(false)} data-testid="sincronizar-feed">
            {t("Sincronizar")}
          </Button>
        </div>
      ) : null}

      {conferido ? (
        <p className="mt-2 text-muted-foreground" data-testid="plano-do-feed">
          {t("Se sincronizar agora:")} {conferido.criar} {t("novos")} · {conferido.atualizar} {t("atualizados")} ·{" "}
          {conferido.desativar} {t("desativados")} · {conferido.inalterados} {t("sem mudança")} · {conferido.erros}{" "}
          {t("com erro")}
        </p>
      ) : null}
      {conferido?.recusa ? (
        <p className="mt-2 rounded-md bg-destructive/10 p-2 text-destructive" role="alert" data-testid="recusa-do-feed">
          {t("Esta leitura não será aplicada:")} {conferido.recusa}
        </p>
      ) : null}
    </section>
  );
}
