"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  CATALOG_CONFIG_DEFAULT,
  parseCatalogConfig,
  type CatalogConfig,
} from "@/lib/agent-engine/agent/catalog-config";

interface Props {
  agentId: string;
  /** `ai_agents.config.catalog` como está no banco (pode ser undefined). */
  inicial: unknown;
  disabled?: boolean;
  /** Chamado depois de salvar, para o pai refletir (opcional). */
  aoSalvar?: (cfg: CatalogConfig) => void;
}

/**
 * Cartão "Catálogo de motos": regras de APRESENTAÇÃO e ESCOLHA das semelhantes.
 * Salva em `ai_agents.config.catalog` via PATCH do agente — é configuração do
 * agente (vale no próximo turno), não conteúdo versionado.
 *
 * Expõe só o que o motor JÁ lê (similaridade determinística, quantidade e
 * critérios). Os demais toggles do schema ficam para quando o motor consumi-los.
 */
export function CatalogoDoAgente({ agentId, inicial, disabled, aoSalvar }: Props) {
  const t = useT();
  const [cfg, setCfg] = useState<CatalogConfig>(() => parseCatalogConfig(inicial));
  const [salvando, setSalvando] = useState(false);

  const porCilindrada = cfg.criterio.includes("cilindrada");
  const porPreco = cfg.criterio.includes("preco");

  function montarCriterio(cil: boolean, preco: boolean): CatalogConfig["criterio"] {
    const lista: CatalogConfig["criterio"] = [];
    if (cil) lista.push("cilindrada");
    if (preco) lista.push("preco");
    return lista.length > 0 ? lista : CATALOG_CONFIG_DEFAULT.criterio;
  }

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, { config: { catalog: cfg } });
      toast.success(t("Regras do catálogo salvas — já valem no próximo atendimento."));
      aoSalvar?.(cfg);
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Catálogo de motos")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Como o agente escolhe e apresenta as motos quando o cliente pede um modelo que não temos. Vale no próximo atendimento.",
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="catalog-deterministica"
          checked={cfg.similaridade_deterministica}
          onCheckedChange={(v) => setCfg((c) => ({ ...c, similaridade_deterministica: v }))}
          disabled={disabled}
        />
        <Label htmlFor="catalog-deterministica">
          {t("Escolher as motos semelhantes automaticamente (sem depender da IA)")}
        </Label>
      </div>

      {cfg.similaridade_deterministica && (
        <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="catalog-qtd">{t("Quantas motos oferecer")}</Label>
            <Input
              id="catalog-qtd"
              type="number"
              min={1}
              max={8}
              value={cfg.similares_qtd}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) {
                  setCfg((c) => ({ ...c, similares_qtd: Math.min(8, Math.max(1, Math.round(n))) }));
                }
              }}
              className="w-24"
              disabled={disabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("Ordem de semelhança")}</Label>
            <div className="flex items-center gap-2">
              <Switch
                id="catalog-cil"
                checked={porCilindrada}
                onCheckedChange={(v) => setCfg((c) => ({ ...c, criterio: montarCriterio(v, porPreco) }))}
                disabled={disabled}
              />
              <Label htmlFor="catalog-cil">{t("Mesma cilindrada primeiro")}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="catalog-preco"
                checked={porPreco}
                onCheckedChange={(v) => setCfg((c) => ({ ...c, criterio: montarCriterio(porCilindrada, v) }))}
                disabled={disabled}
              />
              <Label htmlFor="catalog-preco">{t("Depois, preço mais próximo")}</Label>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
        <Label>{t("Formato das mensagens")}</Label>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-enviar-foto"
            checked={cfg.enviar_foto_automatica}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, enviar_foto_automatica: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-enviar-foto">
            {t("Enviar a foto automaticamente quando a IA esquecer")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-foto-moto"
            checked={cfg.foto_por_moto}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, foto_por_moto: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-foto-moto">
            {t("Uma foto por moto, cada uma com a legenda dela")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-abertura"
            checked={cfg.abertura_sem_citar}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, abertura_sem_citar: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-abertura">
            {t("Abertura sem citar as motos (elas aparecem nas fotos)")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-pergunta"
            checked={cfg.pergunta_separada}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, pergunta_separada: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-pergunta">
            {t("Pergunta final depois das fotos, em mensagem separada")}
          </Label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={salvar} disabled={disabled || salvando}>
          {salvando ? t("Salvando…") : t("Salvar regras do catálogo")}
        </Button>
      </div>
    </Card>
  );
}
