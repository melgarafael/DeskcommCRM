/**
 * /app/instagram/etiquetas — Etiquetas usadas pelas automações Instagram
 *
 * Lista as etiquetas (tags) que as automações aplicam nos contatos ao
 * comentar. Permite criar etiquetas pré-definidas e ver quantos contatos
 * as têm. É a seção "Etiquetas" equivalente ao GD Digital.
 *
 * Acesso: manager+
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

// ── Tipos ──────────────────────────────────────────────────────────────────────

interface EtiquetaInfo {
  nome: string;
  totalContatos: number;
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function EtiquetasInstagramPage() {
  const [etiquetas, setEtiquetas] = useState<EtiquetaInfo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [novaEtiqueta, setNovaEtiqueta] = useState("");
  const [adicionando, setAdicionando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      // Busca as tags usadas em ig_automation_flows (campo acoes[].etiqueta)
      const res = await fetch("/api/v1/ig-automation-flows?limit=100");
      if (!res.ok) throw new Error("Erro");
      const json = await res.json();
      const flows: Array<{ acoes: Array<{ tipo: string; etiqueta?: string; nivel?: string }> }> =
        json.data?.flows ?? [];

      // Extrair etiquetas únicas de todos os flows
      const nomes = new Set<string>();
      for (const flow of flows) {
        for (const acao of flow.acoes ?? []) {
          if (acao.tipo === "add_etiqueta" && acao.etiqueta) nomes.add(acao.etiqueta);
          if (acao.tipo === "add_funil_politico" && acao.nivel) nomes.add(acao.nivel);
        }
      }

      // Para cada etiqueta, buscar quantos contatos a têm
      const resultado: EtiquetaInfo[] = [];
      await Promise.all(
        Array.from(nomes).map(async (nome) => {
          const r = await fetch(
            `/api/v1/contacts?tags=${encodeURIComponent(nome)}&limit=1`,
          );
          const j = await r.json();
          resultado.push({ nome, totalContatos: j.data?.total ?? j.meta?.total ?? 0 });
        }),
      );

      resultado.sort((a, b) => b.totalContatos - a.totalContatos);
      setEtiquetas(resultado);
    } catch {
      // silencioso — mostra vazio
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Funil político padrão
  const NIVEIS_FUNIL = ["Simpatizante", "Apoiador", "Embaixador"];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      {/* Cabeçalho */}
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link href="/app/instagram" className="hover:text-foreground transition-colors">
            Instagram
          </Link>
          <span>/</span>
          <span>Etiquetas</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Etiquetas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Etiquetas aplicadas automaticamente nos contatos pelas automações de Instagram.
        </p>
      </div>

      {/* Funil político */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div>
          <h2 className="font-semibold">Funil Político</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Usados pela ação <strong>Funil político</strong> nas automações. Mapeiam o engajamento
            do cidadão com o mandato.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {NIVEIS_FUNIL.map((nivel, i) => (
            <div
              key={nivel}
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
            >
              <span className="text-lg">{["⭐", "🤝", "🎖️"][i]}</span>
              <div>
                <p className="text-sm font-medium">{nivel}</p>
                <p className="text-xs text-muted-foreground">Nível {i + 1}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Para usar, adicione a ação <strong>Funil político</strong> em um flow e selecione o
          nível desejado.
        </p>
      </div>

      {/* Etiquetas personalizadas */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Etiquetas personalizadas</h2>
          <button
            onClick={carregar}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Atualizar
          </button>
        </div>

        {/* Criar nova */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Nome da etiqueta (ex: Interessado, Lead Quente)"
            value={novaEtiqueta}
            onChange={(e) => setNovaEtiqueta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && novaEtiqueta.trim()) {
                // A etiqueta é adicionada ao criar/editar um flow
                setEtiquetas((prev) => [
                  { nome: novaEtiqueta.trim(), totalContatos: 0 },
                  ...prev.filter((et) => et.nome !== novaEtiqueta.trim()),
                ]);
                setNovaEtiqueta("");
              }
            }}
            className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={() => {
              if (!novaEtiqueta.trim()) return;
              setEtiquetas((prev) => [
                { nome: novaEtiqueta.trim(), totalContatos: 0 },
                ...prev.filter((et) => et.nome !== novaEtiqueta.trim()),
              ]);
              setNovaEtiqueta("");
            }}
            disabled={adicionando || !novaEtiqueta.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            Adicionar
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          As etiquetas aparecem aqui quando usadas em flows. Para aplicar em contatos, adicione a
          ação <strong>Adicionar etiqueta</strong> em um{" "}
          <Link
            href="/app/instagram/automacoes"
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            flow de automação
          </Link>
          .
        </p>

        {/* Estado de carregamento */}
        {carregando && (
          <div className="flex items-center justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {/* Lista de etiquetas */}
        {!carregando && etiquetas.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="text-3xl">🏷️</span>
            <p className="text-sm font-medium">Nenhuma etiqueta ainda</p>
            <p className="text-xs text-muted-foreground">
              As etiquetas aparecem aqui quando usadas em flows de automação.
            </p>
          </div>
        )}

        {!carregando && etiquetas.length > 0 && (
          <div className="divide-y divide-border rounded-xl border bg-card">
            {etiquetas.map((et) => (
              <div key={et.nome} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
                    {et.nome}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {et.totalContatos} contato{et.totalContatos !== 1 ? "s" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
