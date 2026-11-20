"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ConfiguracaoDaOperacao as Configuracao } from "@/lib/operacao/regras";

/**
 * O ajuste da Operação do dia (admin): as quatro etiquetas que viram seções,
 * os pedaços de nome de etapa que contam como proposta e o relatório diário
 * (ligado e hora local). Grava por `PATCH /api/v1/operacao/configuracao`, que
 * audita.
 */
export function ConfiguracaoDaOperacao({ inicial }: { inicial: Configuracao }) {
  const t = useT();
  const router = useRouter();
  const [tags, setTags] = useState(inicial.tags);
  const [etapas, setEtapas] = useState(inicial.etapas_de_proposta.join(", "));
  const [ligado, setLigado] = useState(inicial.relatorio.ligado);
  const [hora, setHora] = useState(inicial.relatorio.hora);
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      await apiClient.patch("/api/v1/operacao/configuracao", {
        tags,
        etapas_de_proposta: etapas
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        relatorio: { ligado, hora },
      });
      setAviso(t("Configuração salva."));
      router.refresh();
    } catch {
      setAviso(t("Erro ao salvar a configuração."));
    } finally {
      setSalvando(false);
    }
  }

  const campoDeTag = (chave: keyof Configuracao["tags"], rotulo: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-text-muted">{rotulo}</span>
      <input
        value={tags[chave]}
        onChange={(e) => setTags({ ...tags, [chave]: e.target.value })}
        maxLength={40}
        required
        className="h-9 rounded-md border border-border bg-background px-3 text-sm"
      />
    </label>
  );

  return (
    <form onSubmit={salvar} className="rounded-lg border border-border bg-surface p-4" data-testid="operacao-configuracao">
      <h2 className="text-sm font-semibold">{t("Configuração da Operação do dia")}</h2>
      <p className="mb-3 text-xs text-text-muted">
        {t("As etiquetas da conversa que separam as seções, e quando o relatório diário é salvo.")}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {campoDeTag("projeto", t("Etiqueta de projeto grande"))}
        {campoDeTag("reclamacao", t("Etiqueta de reclamação"))}
        {campoDeTag("urgente", t("Etiqueta de urgente"))}
        {campoDeTag("produto", t("Etiqueta de pedido de produto"))}
      </div>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-xs text-text-muted">{t("Etapas do funil que contam como proposta (pedaços do nome, separados por vírgula)")}</span>
        <input
          value={etapas}
          onChange={(e) => setEtapas(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ligado} onChange={(e) => setLigado(e.target.checked)} />
          {t("Salvar o relatório automaticamente todo dia")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span>{t("Hora")}</span>
          <select
            value={hora}
            onChange={(e) => setHora(Number(e.target.value))}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={salvando}
          className="ml-auto h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {salvando ? t("Salvando…") : t("Salvar")}
        </button>
      </div>
      {aviso && (
        <p className="mt-2 text-xs text-text-muted" role="status">
          {aviso}
        </p>
      )}
    </form>
  );
}
