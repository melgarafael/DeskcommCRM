"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FlowGraph, FlowNode } from "@/lib/followup/graph-schema";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import type { RFNode, RFNodeData } from "@/lib/followup/graph-mappers";
import { Trash } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

import { ActionForm } from "./forms/ActionForm";
import { ClassifyForm } from "./forms/ClassifyForm";
import { CollectForm } from "./forms/CollectForm";
import { ConditionForm } from "./forms/ConditionForm";
import { EndForm } from "./forms/EndForm";
import { MatchReplyForm } from "./forms/MatchReplyForm";
import { RepeatForm } from "./forms/RepeatForm";
import { SkillForm } from "./forms/SkillForm";
import { WaitForm } from "./forms/WaitForm";
import type { ConfigOf } from "./forms/shared";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

interface Props {
  node: RFNode;
  onChange: (patch: Partial<RFNodeData>) => void;
  onDelete: () => void;
  /** Ramos deste nó que já têm aresta — quem sabe isso é o canvas, que é dono do grafo. */
  ramosLigados?: string[];
  /** Superfície do fluxo — o roteiro de atendimento tem Início e Fim próprios. */
  surface?: FollowupFlowSurface;
  /** O fluxo aberto: o Fim do roteiro não oferece encadear nele mesmo. */
  flowId?: string;
  /** Configurações do GRAFO, editadas no Início do roteiro. */
  settings?: FlowGraph["settings"];
  onSettingsChange?: (settings: FlowGraph["settings"]) => void;
}

/**
 * Casca do formulário de configuração: cabeçalho, rótulo do nó e o formulário
 * do tipo. Cada tipo mora em `forms/` — um arquivo por formulário, para que
 * duas pessoas mexendo em nós diferentes não disputem o mesmo arquivo.
 *
 * A regra que os formulários seguem: o campo só grava no nó vivo (`onChange`)
 * quando o candidato passa no schema — senão mostra erro inline e o canvas
 * mantém a última config válida (nunca um valor pela metade rio acima).
 */
export function NodeConfigPanel({
  node,
  onChange,
  onDelete,
  ramosLigados,
  surface = "followup",
  flowId,
  settings,
  onSettingsChange,
}: Props) {
  const t = useT();
  const type = node.type as FlowNode["type"];
  const visual = NODE_VISUALS[type];
  const Icon = visual.icon;
  const [label, setLabel] = useState(node.data.label);
  const [labelError, setLabelError] = useState<string | null>(null);

  const commitLabel = (value: string) => {
    setLabel(value);
    if (value.trim().length < 1 || value.length > 60) {
      setLabelError(t("Rótulo precisa ter 1 a 60 caracteres."));
      return;
    }
    setLabelError(null);
    onChange({ label: value });
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto" data-testid="node-config-panel">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${visual.chipClassName}`}>
            <Icon size={14} aria-hidden />
          </span>
          {t(visual.paletteLabel)}
        </h2>
        <p className="text-sm text-text-muted">
          {t("Alterações aplicam no rascunho ao digitar — salve na barra de publicação.")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="node-label">{t("Rótulo")}</Label>
        <Input
          id="node-label"
          value={label}
          maxLength={60}
          onChange={(e) => commitLabel(e.target.value)}
        />
        {labelError && <p className="text-xs text-error-fg">{labelError}</p>}
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        {type === "trigger" && surface !== "atendimento" && (
          <p className="text-sm text-text-muted">
            {t(
              "Início do fluxo — sem configuração adicional. O disparo (manual, mudança de etapa, silêncio ou fim de conversa) é definido nas configurações do fluxo.",
            )}
          </p>
        )}
        {type === "trigger" && surface === "atendimento" && (
          <ConfiguracoesDoRoteiro settings={settings} onSettingsChange={onSettingsChange} />
        )}
        {type === "wait" && (
          <WaitForm config={node.data.config as ConfigOf<"wait">} onChange={(config) => onChange({ config })} />
        )}
        {type === "condition" && (
          <ConditionForm
            config={node.data.config as ConfigOf<"condition">}
            onChange={(config) => onChange({ config })}
            ramosLigados={ramosLigados}
          />
        )}
        {type === "ai_classify" && (
          <ClassifyForm
            config={node.data.config as ConfigOf<"ai_classify">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "match_reply" && (
          <MatchReplyForm
            config={node.data.config as ConfigOf<"match_reply">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "repeat" && (
          <RepeatForm
            config={node.data.config as ConfigOf<"repeat">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "collect" && (
          <CollectForm config={node.data.config as ConfigOf<"collect">} onChange={(config) => onChange({ config })} />
        )}
        {type === "skill" && (
          <SkillForm config={node.data.config as ConfigOf<"skill">} onChange={(config) => onChange({ config })} />
        )}
        {type === "action" && (
          <ActionForm config={node.data.config as ConfigOf<"action">} onChange={(config) => onChange({ config })} />
        )}
        {type === "end" && (
          <EndForm
            config={node.data.config as ConfigOf<"end">}
            onChange={(config) => onChange({ config })}
            surface={surface}
            {...(flowId !== undefined ? { flowId } : {})}
          />
        )}
      </div>

      <div className="mt-auto border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-destructive"
          data-testid="delete-node"
          onClick={onDelete}
        >
          <Trash size={14} aria-hidden className="mr-1" />
          {t("Excluir nó")}
        </Button>
      </div>
    </div>
  );
}

/**
 * O Início do ROTEIRO de atendimento: como ele começa e quanto ele insiste.
 * Porte do painel do autor (#1130) com o prazo do PR 2 (`expira_em_horas`).
 * Grava no nível do grafo (`settings`), não num nó.
 */
function ConfiguracoesDoRoteiro({
  settings,
  onSettingsChange,
}: {
  settings?: FlowGraph["settings"];
  onSettingsChange?: (settings: FlowGraph["settings"]) => void;
}) {
  const t = useT();
  const atual = { max_tentativas_pergunta: settings?.max_tentativas_pergunta ?? 3, ...settings };
  const [gatilhos, setGatilhos] = useState((settings?.gatilhos ?? []).join(", "));
  const gravar = (patch: Partial<NonNullable<FlowGraph["settings"]>>) => onSettingsChange?.({ ...atual, ...patch });
  const inteiro = (valor: string, min: number, max: number): number | null => {
    const n = Number(valor);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };

  return (
    <div className="space-y-4" data-testid="configuracoes-do-roteiro">
      <p className="text-sm text-text-muted">
        {t(
          "O roteiro começa quando a mensagem do cliente tem uma palavra-gatilho, ou quando um roteador de intenção o aponta.",
        )}
      </p>
      <div className="space-y-2">
        <Label htmlFor="roteiro-gatilhos">{t("Palavras-gatilho (separe por vírgula)")}</Label>
        <Input
          id="roteiro-gatilhos"
          value={gatilhos}
          onChange={(e) => {
            setGatilhos(e.target.value);
            const lista = e.target.value
              .split(",")
              .map((g) => g.trim())
              .filter((g) => g.length > 0)
              .slice(0, 30);
            const { gatilhos: _anterior, ...resto } = atual;
            onSettingsChange?.(lista.length > 0 ? { ...resto, gatilhos: lista } : resto);
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="roteiro-tentativas">{t("Máximo de tentativas por pergunta")}</Label>
        <Input
          id="roteiro-tentativas"
          type="number"
          min={1}
          max={10}
          defaultValue={atual.max_tentativas_pergunta}
          onChange={(e) => {
            const n = inteiro(e.target.value, 1, 10);
            if (n !== null) gravar({ max_tentativas_pergunta: n });
          }}
        />
        <p className="text-xs text-text-muted">
          {t("Depois de tantas vezes sem resposta, a pergunta é encerrada como não respondida e deixa de ser feita.")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="roteiro-prazo">{t("Encerrar o roteiro depois de quantas horas sem resposta")}</Label>
        <Input
          id="roteiro-prazo"
          type="number"
          min={1}
          max={720}
          placeholder="72"
          defaultValue={settings?.expira_em_horas ?? ""}
          onChange={(e) => {
            if (e.target.value.trim() === "") {
              const { expira_em_horas: _anterior, ...resto } = atual;
              onSettingsChange?.(resto);
              return;
            }
            const n = inteiro(e.target.value, 1, 720);
            if (n !== null) gravar({ expira_em_horas: n });
          }}
        />
        <p className="text-xs text-text-muted">{t("Em branco, o roteiro encerra depois de 72 horas sem resposta.")}</p>
      </div>
    </div>
  );
}

