"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVEDORES, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
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

/**
 * A falha da listagem aparece na tela (#2602). Antes o erro era ignorado e o
 * seletor caía calado no campo livre: o 409 "conecte a assinatura" e o 502 com
 * o motivo só existiam na aba de rede.
 */
function avisoDaFalha(
  provider: Provider,
  erro: unknown,
  t: (texto: string) => string,
): string | null {
  if (!erro) return null;
  if (provider === PROVEDOR_POR_ASSINATURA && erro instanceof ApiError) {
    if (erro.status === 409) {
      return t("Conecte a assinatura do ChatGPT em IA › Credenciais para listar os modelos.");
    }
    if (erro.status === 502) {
      const motivo = erro.details?.motivo;
      const frase = t(
        "Não consegui listar os modelos da assinatura do ChatGPT. A conta continua conectada; tente de novo ou reconecte-a em IA › Credenciais.",
      );
      return typeof motivo === "string" ? `${frase} (${motivo})` : frase;
    }
  }
  return t("Não consegui carregar a lista de modelos. Digite o identificador abaixo.");
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

  const models = query.data ?? [];
  const aviso = avisoDaFalha(provider, query.error, t);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {aviso ? (
        <p role="alert" className="text-sm text-destructive">
          {aviso}
        </p>
      ) : null}
      {models.length === 0 && !query.isLoading ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value, { contextWindow: null })}
          placeholder={t("Digite o identificador do modelo")}
          disabled={disabled}
        />
      ) : (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            const m = models.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || query.isLoading}
        >
          <SelectTrigger id={id}>
            <SelectValue
              placeholder={
                query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))
              }
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.model_id} value={m.model_id}>
                {m.display_name}
                {m.is_default_for_provider ? ` · ${t("default")}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
