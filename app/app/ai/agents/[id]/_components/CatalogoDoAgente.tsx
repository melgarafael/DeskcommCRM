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
import { useCatalogoMapeamento } from "@/hooks/external-db/useCatalogoMapeamento";
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
  aoSalvar?: (cfg: CatalogConfig) => void;
}

/**
 * Cartão "Catálogo de motos" na tela do AGENTE.
 *
 * O QUE o agente mostra e COMO escolhe as semelhantes (tabela, colunas, ordem,
 * quantidade, ligar/desligar) mora no CATÁLOGO — tela de Integração de dados.
 * Aqui ficam só as preferências de MENSAGEM do agente (toggles de formato), e um
 * resumo do catálogo configurado.
 */
export function CatalogoDoAgente({ agentId, inicial, disabled, aoSalvar }: Props) {
  const t = useT();
  const [cfg, setCfg] = useState<CatalogConfig>(() => parseCatalogConfig(inicial));
  const [salvando, setSalvando] = useState(false);
  const catalogo = useCatalogoMapeamento();

  const m = catalogo.data;
  const resumo =
    m === undefined
      ? t("Carregando…")
      : m === null
        ? t("Nenhum catálogo configurado ainda.")
        : `${t("Tabela")}: ${m.table_name} · ${m.similares_qtd} ${t("motos")} · ${
            m.similaridade_deterministica
              ? t("semelhança automática LIGADA")
              : t("semelhança automática desligada")
          }`;

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, { config: { catalog: cfg } });
      toast.success(t("Formato das mensagens salvo — já vale no próximo atendimento."));
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
            "O catálogo (tabela, colunas, semelhança e quantidade) é configurado em Integração de dados. Aqui você ajusta só o formato das mensagens.",
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">{t("Catálogo atual")}:</span> {resumo}
        </p>
      </div>

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
        <div className="flex items-center gap-2">
          <Input
            id="cat-fotos-escolhida"
            type="number"
            min={1}
            max={10}
            className="w-20"
            value={cfg.fotos_moto_escolhida}
            onChange={(e) =>
              setCfg((c) => ({
                ...c,
                fotos_moto_escolhida: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
              }))
            }
            disabled={disabled}
          />
          <Label htmlFor="cat-fotos-escolhida">
            {t("Fotos da moto quando o cliente escolhe uma específica")}
          </Label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={salvar} disabled={disabled || salvando}>
          {salvando ? t("Salvando…") : t("Salvar formato das mensagens")}
        </Button>
      </div>
    </Card>
  );
}
