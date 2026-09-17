"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PROVEDORES } from "@/lib/ai/pontos/provedores";
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
  /**
   * Catálogo já lido no servidor. Sem isto, o primeiro GET no cliente coincidia
   * com a compilação da rota (medido: 10.3s) e o timeout de 10s do `apiClient`
   * pintava "Nenhum modelo disponível" numa lista que existia.
   *
   * `undefined` = a página não pré-buscou, o cliente busca.
   * array (inclusive vazio) = o servidor já olhou; vazio é catálogo vazio de
   * verdade, não erro.
   */
  modelsFromServer?: ModelOption[];
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

export function ModelPicker({
  provider,
  value,
  onChange,
  disabled,
  id,
  placeholder,
  modelsFromServer,
}: Props) {
  const t = useT();
  const doServidor = React.useMemo(
    () => modelsFromServer?.filter((m) => m.provider === provider),
    [modelsFromServer, provider],
  );

  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models ?? [];
    },
    initialData: doServidor,
    // Lista pré-buscada não dispara GET no primeiro paint. `refetch()` do
    // botão "Tentar novamente" ignora `enabled`.
    enabled: doServidor === undefined,
    staleTime: doServidor !== undefined ? Infinity : 60_000,
  });

  const models = query.data ?? [];
  const carregando = query.isLoading && doServidor === undefined;
  const falhou = query.isError && models.length === 0;

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {falhou ? (
        <div data-testid="model-picker-status" className="flex items-center gap-2">
          <p className="text-xs text-destructive">{t("Não consegui carregar os modelos.")}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-0 text-xs"
            onClick={() => void query.refetch()}
          >
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : models.length === 0 && !carregando ? (
        <>
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value, { contextWindow: null })}
            placeholder={t("Digite o identificador do modelo")}
            disabled={disabled}
          />
          <p data-testid="model-picker-status" className="text-xs text-muted-foreground">
            {t("O catálogo deste provedor está vazio.")}
          </p>
        </>
      ) : (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            const m = models.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || carregando}
        >
          <SelectTrigger id={id}>
            <SelectValue
              placeholder={
                carregando ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))
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
      {carregando ? (
        <p data-testid="model-picker-status" className="text-xs text-muted-foreground">
          {t("Carregando…")}
        </p>
      ) : null}
    </div>
  );
}

export function useModelMeta(
  provider: Provider,
  modelId: string,
  modelsFromServer?: ModelOption[],
): ModelOption | null {
  const doServidor = modelsFromServer?.filter((m) => m.provider === provider);
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models ?? [];
    },
    initialData: doServidor,
    enabled: doServidor === undefined,
    staleTime: doServidor !== undefined ? Infinity : 60_000,
  });
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
