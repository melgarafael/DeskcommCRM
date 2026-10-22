"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { internalTaskConfigSchema } from "@/lib/followup/graph-schema";
import { PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";

import type { ConfigOf } from "./shared";

const ROTULO_DA_PRIORIDADE: Record<(typeof PRIORIDADES_DA_TAREFA)[number], string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  urgent: "Urgente",
};

/**
 * O nó `internal_task` (#1540) — o formulário que faltava no construtor.
 *
 * A paleta oferece a caixa (`NOS_DA_SUPERFICIE`), o schema aceita o nó, o
 * motor executa (`node-handlers.ts` → `criarTarefaInterna`) — e a tela não
 * deixava configurar título, prazo, atribuição nem prioridade: quem arrastava
 * ficava com o `defaultConfig` para sempre. Os campos são os MESMOS da ação
 * `create_task` (`ActionConfigForm`) e do schema do nó, de propósito — as
 * duas portas criam a mesma tarefa e duas telas diferentes ensinariam duas
 * verdades.
 *
 * A regra do painel vale aqui: o candidato só vira nó vivo quando passa no
 * `internalTaskConfigSchema` (`título` vazio, prazo fora de 0…365) — senão,
 * erro inline e o canvas guarda a última configuração válida.
 */
export function InternalTaskForm({
  config,
  onChange,
}: {
  config: ConfigOf<"internal_task">;
  onChange: (c: ConfigOf<"internal_task">) => void;
}) {
  const t = useT();
  const { data: members } = useAssignableMembers(true);
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (candidato: ConfigOf<"internal_task">) => {
    const parsed = internalTaskConfigSchema.safeParse(candidato);
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };

  const atribuido =
    typeof config.atribuir_a === "object" ? config.atribuir_a.usuario_id : "dono_do_lead";

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="internal-task-form">
      <div className="space-y-1 sm:col-span-2">
        <p className="text-xs text-text-muted">
          {t("Este nó cria uma tarefa para a equipe — nenhuma mensagem sai para o cliente.")}
        </p>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="internal-task-titulo">{t("Título da tarefa")}</Label>
        <Input
          id="internal-task-titulo"
          value={config.titulo}
          onChange={(e) => gravar({ ...config, titulo: e.target.value })}
          placeholder={t("Ligar para {{contact.name}} sobre {{lead.title}}")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="internal-task-prazo">{t("Vence em (dias)")}</Label>
        <Input
          id="internal-task-prazo"
          type="number"
          min={0}
          max={365}
          value={config.vence_em_dias}
          onChange={(e) => gravar({ ...config, vence_em_dias: Number(e.target.value) })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="internal-task-prioridade">{t("Prioridade")}</Label>
        <Select
          value={config.prioridade}
          onValueChange={(v) => gravar({ ...config, prioridade: v as PrioridadeDaTarefa })}
        >
          <SelectTrigger id="internal-task-prioridade">
            <SelectValue placeholder={t("Prioridade")} />
          </SelectTrigger>
          <SelectContent>
            {PRIORIDADES_DA_TAREFA.map((valor) => (
              <SelectItem key={valor} value={valor}>
                {t(ROTULO_DA_PRIORIDADE[valor])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="internal-task-atribuir">{t("Atribuir a")}</Label>
        <Select
          value={atribuido}
          onValueChange={(v) =>
            gravar({
              ...config,
              atribuir_a: v === "dono_do_lead" ? "dono_do_lead" : { usuario_id: v },
            })
          }
        >
          <SelectTrigger id="internal-task-atribuir">
            <SelectValue placeholder={t("Dono do negócio")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dono_do_lead">{t("Dono do negócio")}</SelectItem>
            {(members ?? []).map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.full_name ?? m.user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {erro && (
        <p className="text-xs text-error-fg sm:col-span-2" role="alert">
          {erro}
        </p>
      )}
    </div>
  );
}
