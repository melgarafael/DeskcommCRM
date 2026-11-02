"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Check, ChevronDown, DollarSign } from "lucide-react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PROVEDORES, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { ehVarianteEmLote } from "@/lib/ai/catalogo/variante-em-lote";
import { formatarDolaresPorMilhao } from "@/lib/ai/catalogo/preco-do-modelo";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

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
  /** Centavos de dólar por milhão de tokens. `null` = desconhecido, não grátis. */
  input_price_per_million_cents?: number | null;
  output_price_per_million_cents?: number | null;
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

/** Sem acento e sem caixa: "gpt" acha "GPT-6", "opus" acha "Ópus". */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function filtrarModelos(models: ModelOption[], busca: string): ModelOption[] {
  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  if (termos.length === 0) return models;
  return models.filter((m) => {
    const alvo = normalizar(`${m.display_name} ${m.model_id}`);
    return termos.every((termo) => alvo.includes(termo));
  });
}

/**
 * O custo do modelo, em dólares por milhão de tokens. Preço desconhecido
 * (`null`) diz "não informado" — nunca "grátis": quem escolhe pelo preço
 * confiaria num zero que ninguém mediu.
 */
function PrecoDoModelo({ modelo }: { modelo: ModelOption }) {
  const t = useT();
  const idioma = useIdioma();

  const rotulo = (centavos: number | null | undefined): string => {
    if (centavos === 0) return t("Grátis");
    return formatarDolaresPorMilhao(centavos, idioma) ?? t("Preço não informado");
  };
  const entrada = rotulo(modelo.input_price_per_million_cents);
  const saida = rotulo(modelo.output_price_per_million_cents);
  const titulo = t("Preço por 1 milhão de tokens");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`${titulo}: ${t("Entrada")} ${entrada}, ${t("Saída")} ${saida}`}
          data-testid="preco-do-modelo"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <DollarSign className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">
        <p className="font-medium">{titulo}</p>
        <p>
          {t("Entrada")}: {entrada}
        </p>
        <p>
          {t("Saída")}: {saida}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelPicker({ provider, value, onChange, disabled, id, placeholder }: Props) {
  const t = useT();
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const listaRef = React.useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });

  const models = React.useMemo(() => query.data ?? [], [query.data]);
  const aviso = avisoDaFalha(provider, query.error, t);
  const visiveis = React.useMemo(() => filtrarModelos(models, busca), [models, busca]);
  const escolhido = models.find((m) => m.model_id === value);
  // O agente pode já ter salvo um id que a lista não oferece mais (a variante
  // `:batch`, ou um id digitado à mão): o gatilho mostra o que está salvo em vez
  // de ficar em branco, e a variante em lote ganha o aviso do porquê não serve.
  // Enquanto a lista carrega, o id cru não vira rótulo: o gatilho diz "Carregando…"
  // e só depois troca pelo nome de exibição (ou, se a lista não o conhece, pelo id).
  const nomeDoEscolhido = escolhido ? escolhido.display_name : null;
  const rotuloDoGatilho = nomeDoEscolhido ?? (query.isLoading ? null : value || null);

  function escolher(m: ModelOption) {
    onChange(m.model_id, { contextWindow: m.context_window ?? null });
    setAberto(false);
    setBusca("");
  }

  function opcoes(): HTMLElement[] {
    return Array.from(listaRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {aviso ? (
        <p role="alert" className="text-sm text-destructive">
          {aviso}
        </p>
      ) : null}
      {ehVarianteEmLote(value) ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Este modelo é a variante de lote e não responde no chat. Escolha outro da lista.")}
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
        <Popover
          open={aberto}
          onOpenChange={(proximo) => {
            setAberto(proximo);
            if (!proximo) setBusca("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              id={id}
              role="combobox"
              aria-expanded={aberto}
              aria-haspopup="listbox"
              disabled={disabled || query.isLoading}
              data-placeholder={rotuloDoGatilho ? undefined : ""}
              className="flex h-9 min-h-11 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-sm ring-offset-background focus:ring-1 focus:ring-ring focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground lg:min-h-0"
            >
              <span className="line-clamp-1 text-left">
                {rotuloDoGatilho ??
                  (query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo")))}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--radix-popover-trigger-width) min-w-72 p-0"
          >
            <TooltipProvider delayDuration={150}>
              <div className="border-b p-2">
                <Input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={t("Buscar modelo")}
                  aria-label={t("Buscar modelo")}
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (visiveis[0]) escolher(visiveis[0]);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      opcoes()[0]?.focus();
                    }
                  }}
                />
              </div>
              <div
                ref={listaRef}
                role="listbox"
                aria-label={t("Modelo")}
                className="max-h-64 overflow-y-auto p-1"
              >
                {visiveis.length === 0 ? (
                  <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                    {t("Nenhum modelo encontrado")}
                  </p>
                ) : (
                  visiveis.map((m) => {
                    const selecionado = m.model_id === value;
                    return (
                      <div
                        key={m.model_id}
                        role="option"
                        aria-selected={selecionado}
                        tabIndex={-1}
                        onClick={() => escolher(m)}
                        onKeyDown={(e) => {
                          const lista = opcoes();
                          const i = lista.indexOf(e.currentTarget);
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            escolher(m);
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            lista[i + 1]?.focus();
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            if (i <= 0) {
                              (listaRef.current?.parentElement?.querySelector("input") as
                                | HTMLInputElement
                                | null)?.focus();
                            } else {
                              lista[i - 1]?.focus();
                            }
                          }
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent focus:bg-accent",
                          selecionado && "font-medium",
                        )}
                      >
                        <Check
                          className={cn("size-4 shrink-0", selecionado ? "opacity-100" : "opacity-0")}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {m.display_name}
                          {m.is_default_for_provider ? ` · ${t("default")}` : ""}
                        </span>
                        <PrecoDoModelo modelo={m} />
                      </div>
                    );
                  })
                )}
              </div>
            </TooltipProvider>
          </PopoverContent>
        </Popover>
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
