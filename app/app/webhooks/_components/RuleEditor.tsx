"use client";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash, CaretUp, CaretDown } from "@/lib/ui/icons";
import { createAutomationRuleSchema, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import {
  useCreateAutomationRule,
  useUpdateAutomationRule,
  type AutomationRuleRow,
} from "@/hooks/webhooks/useAutomationRules";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import { TRIGGER_LABELS, ACTION_LABELS, type TriggerEvent, type ActionType } from "./labels";
import { ActionConfigForm, defaultActionConfig, type ActionItem } from "./ActionConfigForm";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutomationRuleRow | null;
}

type Op = "eq" | "neq" | "contains";

interface ConditionRow {
  field: string;
  op: Op;
  value: string;
}

interface CuratedField {
  value: string;
  label: string;
  op: Op;
  kind?: "stage";
}

const LEAD_FIELDS: CuratedField[] = [
  { value: "lead.title", label: "Nome do lead", op: "eq" },
  { value: "lead.tags", label: "Tags do lead", op: "contains" },
  // utm_* entram pelo webhook em source_metadata (decisão da rota inbound),
  // não em custom_fields — o path aqui tem que apontar pra onde o dado mora.
  { value: "lead.source_metadata.utm_source", label: "Origem (utm_source)", op: "eq" },
];
const STAGE_FIELD: CuratedField = {
  value: "event.to_stage_id",
  label: "Etapa de destino",
  op: "eq",
  kind: "stage",
};
const MESSAGE_FIELDS: CuratedField[] = [
  { value: "event.body_preview", label: "Texto da mensagem", op: "contains" },
  { value: "contact.tags", label: "Tags do contato", op: "contains" },
];
const TAG_ADDED_FIELD: CuratedField = {
  value: "event.added_tags",
  label: "Tag adicionada",
  op: "contains",
};

// ponytail: etapa de destino usa o funil default (cobre o caso comum de 1
// funil); se o produto ganhar múltiplos funis relevantes aqui, trocar por um
// seletor de funil antes do de etapa.
const CURATED_FIELDS: Record<TriggerEvent, CuratedField[]> = {
  "lead.created": LEAD_FIELDS,
  "lead.stage_changed": [...LEAD_FIELDS, STAGE_FIELD],
  "message.received": MESSAGE_FIELDS,
  "lead.tag_added": [...LEAD_FIELDS, TAG_ADDED_FIELD],
  "contact.tag_added": [TAG_ADDED_FIELD],
};

const OP_LABELS: Record<Op, string> = { eq: "é", neq: "não é", contains: "contém" };

function emptyCondition(): ConditionRow {
  return { field: "", op: "eq", value: "" };
}

export function RuleEditor({ open, onOpenChange, rule }: Props) {
  const isEdit = !!rule;
  const [name, setName] = React.useState("");
  const [triggerEvent, setTriggerEvent] = React.useState<TriggerEvent | "">("");
  const [conditions, setConditions] = React.useState<ConditionRow[]>([]);
  const [advancedRows, setAdvancedRows] = React.useState<Record<number, boolean>>({});
  const [actions, setActions] = React.useState<ActionItem[]>([]);

  const create = useCreateAutomationRule();
  const update = useUpdateAutomationRule();
  const saving = create.isPending || update.isPending;

  const { data: pipelinesRes } = usePipelines();
  const defaultPipeline =
    pipelinesRes?.data?.find((p) => p.is_default) ?? pipelinesRes?.data?.[0] ?? null;
  const { data: boardRes } = usePipelineStages(defaultPipeline?.id ?? null);
  const stages = boardRes?.data?.stages ?? [];

  React.useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? "");
    setTriggerEvent((rule?.trigger_event as TriggerEvent) ?? "");
    setConditions(
      rule?.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })) ?? [],
    );
    setAdvancedRows({});
    setActions((rule?.actions as ActionItem[] | undefined) ?? []);
  }, [open, rule]);

  const curatedFields = triggerEvent ? CURATED_FIELDS[triggerEvent] : [];

  const updateCondition = (idx: number, patch: Partial<ConditionRow>) => {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const removeCondition = (idx: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  };

  const addCondition = () => {
    setConditions((prev) => [...prev, emptyCondition()]);
  };

  const addAction = (type: ActionType) => {
    setActions((prev) => [...prev, defaultActionConfig(type)]);
  };

  const removeAction = (idx: number) => {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveAction = (idx: number, dir: -1 | 1) => {
    setActions((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      const a = next[idx];
      const b = next[target];
      if (!a || !b) return prev;
      next[idx] = b;
      next[target] = a;
      return next;
    });
  };

  const onSubmit = async () => {
    const payload = {
      name,
      trigger_event: triggerEvent,
      conditions: conditions
        .filter((c) => c.field.trim() && c.value.trim())
        .map((c) => ({ field: c.field.trim(), op: c.op, value: c.value.trim() })),
      actions,
    };
    const parsed = createAutomationRuleSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Revise os campos da automação.");
      return;
    }
    try {
      if (rule) {
        await update.mutateAsync({ id: rule.id, ...parsed.data });
        toast.success("Automação atualizada.");
      } else {
        await create.mutateAsync(parsed.data);
        toast.success("Automação criada — ligue quando estiver pronta.");
      }
      onOpenChange(false);
    } catch {
      /* showApiError já mostrou o toast */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{isEdit ? "Editar automação" : "Nova automação"}</SheetTitle>
          <SheetDescription>
            Monte a regra em três passos: quando algo acontece, opcionalmente confira uma
            condição, e então dispare uma ou mais ações.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-8">
          <div className="space-y-2">
            <Label htmlFor="rule-name">Nome da automação</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Boas-vindas a contato novo"
              maxLength={120}
            />
          </div>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-text">QUANDO</h3>
            <Select
              value={triggerEvent}
              onValueChange={(v) => {
                setTriggerEvent(v as TriggerEvent);
                setConditions([]);
                setAdvancedRows({});
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Escolha o gatilho" />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_EVENTS.map((ev) => (
                  <SelectItem key={ev} value={ev}>
                    {TRIGGER_LABELS[ev]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <section className="space-y-3">
            <h3 className="text-lg font-semibold text-text">SE (opcional)</h3>
            {conditions.map((cond, idx) => {
              // Linha nova (campo vazio) começa no modo curado — o avançado é
              // escape p/ quem sabe o path; só cai nele sozinho ao EDITAR uma
              // regra cujo campo salvo não está na lista curada.
              const isAdvanced =
                advancedRows[idx] ??
                (cond.field !== "" && !curatedFields.some((f) => f.value === cond.field));
              const curated = curatedFields.find((f) => f.value === cond.field);
              return (
                <div key={idx} className="space-y-1 rounded-sm border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdvanced ? (
                      <Input
                        className="flex-1 basis-40"
                        value={cond.field}
                        onChange={(e) => updateCondition(idx, { field: e.target.value })}
                        placeholder="ex: lead.custom_fields.minha_chave"
                      />
                    ) : (
                      <Select
                        value={cond.field}
                        onValueChange={(v) => {
                          const f = curatedFields.find((cf) => cf.value === v);
                          updateCondition(idx, { field: v, op: f?.op ?? "eq" });
                        }}
                      >
                        <SelectTrigger className="flex-1 basis-40">
                          <SelectValue placeholder="Campo" />
                        </SelectTrigger>
                        <SelectContent>
                          {curatedFields.map((f) => (
                            <SelectItem key={f.value} value={f.value}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Select
                      value={cond.op}
                      onValueChange={(v) => updateCondition(idx, { op: v as Op })}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(OP_LABELS) as Op[]).map((op) => (
                          <SelectItem key={op} value={op}>
                            {OP_LABELS[op]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {curated?.kind === "stage" ? (
                      <Select
                        value={cond.value}
                        onValueChange={(v) => updateCondition(idx, { value: v })}
                      >
                        <SelectTrigger className="flex-1 basis-40">
                          <SelectValue placeholder="Etapa" />
                        </SelectTrigger>
                        <SelectContent>
                          {stages.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="flex-1 basis-40"
                        value={cond.value}
                        onChange={(e) => updateCondition(idx, { value: e.target.value })}
                        placeholder="Valor"
                      />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCondition(idx)}
                      aria-label="Remover condição"
                    >
                      <Trash />
                    </Button>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-4"
                    onClick={() =>
                      setAdvancedRows((prev) => ({ ...prev, [idx]: !isAdvanced }))
                    }
                  >
                    {isAdvanced ? "usar campo da lista" : "usar campo avançado"}
                  </button>
                </div>
              );
            })}
            <Button
              type="button"
              variant="secondary"
              onClick={addCondition}
              disabled={!triggerEvent || conditions.length >= 10}
            >
              <Plus /> Adicionar condição
            </Button>
          </section>

          <section className="space-y-3">
            <h3 className="text-lg font-semibold text-text">ENTÃO</h3>
            {actions.map((action, idx) => (
              <div key={idx} className="space-y-3 rounded-sm border border-border p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-text">{ACTION_LABELS[action.type]}</p>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={idx === 0}
                      onClick={() => moveAction(idx, -1)}
                      aria-label="Mover ação para cima"
                    >
                      <CaretUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={idx === actions.length - 1}
                      onClick={() => moveAction(idx, 1)}
                      aria-label="Mover ação para baixo"
                    >
                      <CaretDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeAction(idx)}
                      aria-label="Remover ação"
                    >
                      <Trash />
                    </Button>
                  </div>
                </div>
                <ActionConfigForm
                  action={action}
                  onChange={(next) =>
                    setActions((prev) => prev.map((a, i) => (i === idx ? next : a)))
                  }
                />
              </div>
            ))}
            <Select
              value=""
              onValueChange={(v) => addAction(v as ActionType)}
              disabled={actions.length >= 10}
            >
              <SelectTrigger>
                <SelectValue placeholder="Adicionar ação" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACTION_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {!isEdit ? (
            <p className="rounded-sm border border-border bg-muted p-3 text-sm text-muted-foreground">
              A automação nasce pausada. Revise e ligue quando estiver pronta.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={onSubmit} disabled={saving}>
              {saving ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar automação"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
