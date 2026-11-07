"use client";
import { agentOperationOptions } from "@/lib/amigo/agent-permissions";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";
export function AmigoAgentTools({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-2 text-sm font-semibold">Operações do Amigo para este agente</legend>
      <p className="text-xs text-muted-foreground">
        Selecione as ações para este agente. O limite geral da clínica também se aplica. Salve e
        publique o agente para aplicar as alterações. Consultas globais e chegada são reservadas à
        equipe. Essas opções contam no limite de {TETO_TOOLS_POR_AGENTE} capacidades por agente.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {agentOperationOptions.map((option) => {
          const id = `crm_amigo_${option.id}`;
          return (
            <label className="flex items-start gap-2 text-sm" key={id}>
              <input
                type="checkbox"
                checked={!option.humanOnly && value.includes(id)}
                disabled={disabled || option.humanOnly}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, id] : value.filter((v) => v !== id))
                }
              />
              <span>
                {option.label}
                {option.humanOnly ? " (somente equipe)" : ""}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
