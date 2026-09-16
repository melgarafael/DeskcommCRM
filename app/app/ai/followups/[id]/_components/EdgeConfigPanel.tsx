"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ArrowRight, Trash } from "@/lib/ui/icons";
import { conditionKey } from "@/lib/followup/edge-condition-options";
import { branchIdForCondition, nodeBranches } from "@/lib/followup/graph-schema";
import type { FlowEdge, FlowNode } from "@/lib/followup/graph-schema";
import { rotuloDoRamo } from "@/lib/followup/rotulo-do-ramo";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  sourceNode: FlowNode | undefined;
  targetNode: FlowNode | undefined;
  condition: FlowEdge["condition"];
  onChange: (condition: FlowEdge["condition"]) => void;
  onDelete: () => void;
}

/**
 * Painel da aresta selecionada. As opções são as SAÍDAS DO NÓ DE ORIGEM, as
 * mesmas que o canvas desenha e com o mesmo texto — coerência por construção,
 * não por duas listas mantidas em paralelo.
 *
 * Antes a lista vinha do TIPO do nó, e por isso um nó no modo uma-saída-por-
 * regra continuava oferecendo "Sim"/"Não": opções que nenhum ramo dele casa.
 * Um controle que a tela oferece e o motor ignora é pior que um ausente — o
 * ausente o usuário contorna, o decorativo ele acredita.
 */
export function EdgeConfigPanel({ sourceNode, targetNode, condition, onChange, onDelete }: Props) {
  const t = useT();
  const options = nodeBranches(
    sourceNode ?? { type: "trigger", config: {} },
  ).map((branch) => ({
    key: conditionKey(branch.condition),
    label: t(rotuloDoRamo(branch)),
    condition: branch.condition,
  }));
  // Aresta apontando para um ramo que não existe mais (a regra foi apagada):
  // nenhuma opção casa, o Select fica vazio em vez de mentir que está tudo bem,
  // e o publish reprova com `missing_branch_edge` dizendo qual ramo ficou só.
  const ramoAtual = branchIdForCondition(sourceNode, condition);
  const currentKey = ramoAtual === null ? "" : conditionKey(condition);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto" data-testid="edge-config-panel">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-text">{t("Condição da aresta")}</h2>
        <p className="flex items-center gap-1.5 text-sm text-text-muted">
          <span className="truncate">{sourceNode?.label ?? "?"}</span>
          <ArrowRight size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{targetNode?.label ?? "?"}</span>
        </p>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor="edge-condition">{t("Quando seguir por esta aresta")}</Label>
        <Select
          value={currentKey}
          onValueChange={(v) => {
            const option = options.find((o) => o.key === v);
            if (option) onChange(option.condition);
          }}
        >
          <SelectTrigger id="edge-condition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sourceNode && nodeBranches(sourceNode).length > 1 && (
          <p className="text-xs text-text-muted">
            {t("São as saídas do nó")} &quot;{sourceNode.label}&quot; — {t("as mesmas que aparecem no card.")}
          </p>
        )}
      </div>

      <div className="mt-auto border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-destructive"
          data-testid="delete-edge"
          onClick={onDelete}
        >
          <Trash size={14} aria-hidden className="mr-1" />
          {t("Excluir aresta")}
        </Button>
      </div>
    </div>
  );
}
