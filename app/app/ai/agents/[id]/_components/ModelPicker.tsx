"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { useT } from "@/hooks/i18n/useT";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a mesma lista única da tela de
 * Credenciais e da rota. Como literal aqui, o seletor de modelo do agente não
 * conseguia representar um agente publicado em OpenRouter.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Texto do estado "nada escolhido". Existe porque nem todo uso deste seletor
   * trata vazio como erro: no papel Operador, vazio SIGNIFICA "usa o mesmo
   * modelo que conversa", e chamar isso de "Selecione um modelo" mentiria.
   */
  placeholder?: string;
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

export function ModelPicker({ provider, value, onChange, disabled, id, placeholder }: Props) {
  const t = useT();
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });

  const models = React.useMemo(() => query.data ?? [], [query.data]);
  // O catálogo de um provedor pode ter centenas de modelos (o OpenRouter tem),
  // e procurar no olho era a reclamação. O identificador técnico vai em
  // `keywords` porque é ele que quem já conhece o modelo digita.
  const opcoes = React.useMemo<OpcaoDeSelecao[]>(
    () =>
      models.map((m) => ({
        value: m.model_id,
        label: m.is_default_for_provider ? `${m.display_name} · ${t("default")}` : m.display_name,
        keywords: [m.model_id],
      })),
    [models, t],
  );

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {models.length === 0 && !query.isLoading ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value, { contextWindow: null })}
          placeholder={t("Digite o identificador do modelo")}
          disabled={disabled}
        />
      ) : (
        <SearchableSelect
          id={id}
          options={opcoes}
          value={value || undefined}
          onValueChange={(v) => {
            const m = models.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || query.isLoading}
          placeholder={query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))}
          searchPlaceholder={t("Buscar modelo…")}
          emptyMessage={t("Nenhum modelo encontrado")}
        />
      )}
    </div>
  );
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
