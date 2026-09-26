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
import { parseCatalogConfig, type CatalogConfig } from "@/lib/agent-engine/agent/catalog-config";

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
 * O QUE o agente lê (tabela, colunas, ordem, semelhança automática) mora no
 * CATÁLOGO — tela de Integração de dados. Aqui ficam as preferências de MENSAGEM
 * do agente e a QUANTIDADE de motos (fonte única, decisão do dono 2026-09-25):
 * `similares_qtd` + `usar_limite_quantidade` + `especificacao_mostra_todas`.
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
        : `${t("Tabela")}: ${m.table_name} · ${
            m.similaridade_deterministica
              ? t("semelhança automática LIGADA")
              : t("semelhança automática desligada")
          }`;

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, { config: { catalog: cfg } });
      toast.success(t("Catálogo do agente salvo — já vale no próximo atendimento."));
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
            "A tabela, as colunas e a semelhança automática são configuradas em Integração de dados. A QUANTIDADE de motos e o formato das mensagens ficam aqui, no agente.",
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
            min={0}
            max={50}
            className="w-20"
            value={cfg.fotos_moto_escolhida}
            onChange={(e) =>
              setCfg((c) => ({
                ...c,
                fotos_moto_escolhida: Math.min(50, Math.max(0, Number(e.target.value) || 0)),
              }))
            }
            disabled={disabled}
          />
          <Label htmlFor="cat-fotos-escolhida">
            {t("Fotos da moto escolhida (0 = todas as fotos)")}
          </Label>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
        <Label>{t("Quantidade e escolha das motos")}</Label>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-especificacao"
            checked={cfg.especificacao_mostra_todas}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, especificacao_mostra_todas: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-especificacao">
            {t(
              "Quando o cliente cita um MODELO que existe, mostrar TODAS as unidades que batem (ignora o limite)",
            )}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cat-limite"
            checked={cfg.usar_limite_quantidade}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, usar_limite_quantidade: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-limite">
            {t("Usar limite de quantidade quando o modelo pedido NÃO existe (alternativas)")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="cat-similares-qtd"
            type="number"
            min={1}
            max={8}
            className="w-20"
            value={cfg.similares_qtd}
            onChange={(e) =>
              setCfg((c) => ({
                ...c,
                similares_qtd: Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 3))),
              }))
            }
            disabled={disabled || !cfg.usar_limite_quantidade}
          />
          <Label htmlFor="cat-similares-qtd">
            {t("Quantas alternativas oferecer (1 a 8) quando o modelo não existe")}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Desligue o limite para mostrar todas as alternativas candidatas. O limite não afeta um modelo que existe quando a opção acima está ligada.",
          )}
        </p>
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Switch
            id="cat-enviar-todas"
            checked={cfg.enviar_todas_que_casam}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, enviar_todas_que_casam: v }))}
            disabled={disabled}
          />
          <Label htmlFor="cat-enviar-todas">
            {t(
              "Enviar TODAS as motos que casam o critério do pedido (ignora o limite e não pergunta “quer mais?”)",
            )}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Ligado: o motor envia todas as motos que casarem as colunas marcadas como “Critério de envio” no catálogo. Desligado: envia até o limite, completa com o mesmo perfil e pergunta se o cliente quer mais opções.",
          )}
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={salvar} disabled={disabled || salvando}>
          {salvando ? t("Salvando…") : t("Salvar configuração do catálogo")}
        </Button>
      </div>
    </Card>
  );
}
