"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { GuardrailsEditor } from "@/components/ai/GuardrailsEditor";
import { SystemPromptEditor } from "@/components/ai/SystemPromptEditor";
import { useAgent, useUpdateAgent, type AgentRow } from "@/hooks/ai/useAgent";
import {
  AGENT_CONFIG_DEFAULTS,
  AGENT_MODELS,
  agentConfigSchema,
  agentPatchSchema,
  guardrailsSchema,
  type AgentConfig,
  type AgentModel,
  type AgentPatch,
  type GuardrailItem,
} from "@/lib/ai/guardrails-schema";

interface Props {
  agentId: string;
  initialData?: AgentRow;
  readOnly?: boolean;
}

interface FormState {
  name: string;
  description: string;
  is_active: boolean;
  model: AgentModel;
  system_prompt: string;
  config: AgentConfig;
  guardrails: GuardrailItem[];
}

function buildFormState(agent: AgentRow): FormState {
  const cfgRaw = (agent.config ?? {}) as Record<string, unknown>;
  const cfgParsed = agentConfigSchema.safeParse({ ...AGENT_CONFIG_DEFAULTS, ...cfgRaw });
  const config: AgentConfig = cfgParsed.success ? cfgParsed.data : AGENT_CONFIG_DEFAULTS;

  const grRaw = Array.isArray(agent.guardrails) ? agent.guardrails : [];
  const grParsed = guardrailsSchema.safeParse(grRaw);
  const guardrails: GuardrailItem[] = grParsed.success ? grParsed.data : [];

  const modelOk = (AGENT_MODELS as readonly string[]).includes(agent.model);
  const model: AgentModel = (modelOk ? agent.model : "anthropic/claude-sonnet-4-6") as AgentModel;

  return {
    name: agent.name,
    description: agent.description ?? "",
    is_active: agent.is_active,
    model,
    system_prompt: agent.system_prompt,
    config,
    guardrails,
  };
}

function diffPatch(initial: FormState, current: FormState): AgentPatch {
  const patch: AgentPatch = {};
  if (initial.name !== current.name) patch.name = current.name;
  if (initial.description !== current.description) {
    patch.description = current.description.trim() === "" ? null : current.description;
  }
  if (initial.is_active !== current.is_active) patch.is_active = current.is_active;
  if (initial.model !== current.model) patch.model = current.model;
  if (initial.system_prompt !== current.system_prompt)
    patch.system_prompt = current.system_prompt;
  if (JSON.stringify(initial.config) !== JSON.stringify(current.config)) {
    patch.config = current.config;
  }
  if (JSON.stringify(initial.guardrails) !== JSON.stringify(current.guardrails)) {
    patch.guardrails = current.guardrails;
  }
  return patch;
}

export function AgentEditor({ agentId, initialData, readOnly = false }: Props) {
  const query = useAgent(agentId, { initialData });
  const update = useUpdateAgent(agentId);

  const agent = query.data;

  const [formState, setFormState] = React.useState<FormState | null>(
    agent ? buildFormState(agent) : null,
  );
  const [baselineState, setBaselineState] = React.useState<FormState | null>(
    agent ? buildFormState(agent) : null,
  );

  // Sync state quando dados frescos chegam (ex: refetch / SSR initialData).
  React.useEffect(() => {
    if (!agent) return;
    setFormState((prev) => prev ?? buildFormState(agent));
    setBaselineState((prev) => prev ?? buildFormState(agent));
  }, [agent]);

  if (!agent || !formState || !baselineState) {
    return <p className="text-sm text-muted-foreground">Carregando agent…</p>;
  }

  const dirty = JSON.stringify(formState) !== JSON.stringify(baselineState);

  function patchForm(p: Partial<FormState>) {
    setFormState((prev) => (prev ? { ...prev, ...p } : prev));
  }

  function patchConfig(p: Partial<AgentConfig>) {
    setFormState((prev) => (prev ? { ...prev, config: { ...prev.config, ...p } } : prev));
  }

  async function handleSave() {
    if (!formState || !baselineState) return;

    // Valida guardrails antes de enviar
    const grCheck = guardrailsSchema.safeParse(formState.guardrails);
    if (!grCheck.success) {
      const flat = grCheck.error.flatten();
      const firstErr =
        Object.values(flat.fieldErrors)[0]?.[0] ?? flat.formErrors[0] ?? "Guardrails inválidos.";
      toast.error(`Guardrails inválidos: ${firstErr}`);
      return;
    }

    const patch = diffPatch(baselineState, formState);
    if (Object.keys(patch).length === 0) {
      toast.info("Nada para salvar.");
      return;
    }

    const validated = agentPatchSchema.safeParse(patch);
    if (!validated.success) {
      const flat = validated.error.flatten();
      const firstErr =
        Object.values(flat.fieldErrors)[0]?.[0] ?? flat.formErrors[0] ?? "Campos inválidos.";
      toast.error(`Erro ao salvar: ${firstErr}`);
      return;
    }

    try {
      const updated = await update.mutateAsync(validated.data);
      const next = buildFormState(updated);
      setBaselineState(next);
      setFormState(next);
    } catch {
      // toast já mostrado em onError do hook
    }
  }

  function handleReset() {
    setFormState(baselineState);
  }

  const disabled = readOnly || update.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{agent.name}</h2>
          <p className="text-xs text-muted-foreground">
            {agent.is_default ? "Agent default · " : ""}Criado em{" "}
            {new Date(agent.created_at).toLocaleDateString("pt-PT")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={!dirty || disabled}>
            Descartar
          </Button>
          <Button onClick={handleSave} disabled={!dirty || disabled}>
            {update.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">Geral</TabsTrigger>
          <TabsTrigger value="model">Modelo</TabsTrigger>
          <TabsTrigger value="rag">RAG</TabsTrigger>
          <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card className="space-y-4 p-4">
            <div className="space-y-1">
              <Label htmlFor="name">Nome</Label>
              <Input
                id="name"
                value={formState.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                disabled={disabled}
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Descrição</Label>
              <Textarea
                id="description"
                value={formState.description}
                onChange={(e) => patchForm({ description: e.target.value })}
                disabled={disabled}
                rows={3}
                maxLength={500}
                placeholder="Descrição interna do agent"
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={formState.is_active}
                onCheckedChange={(v) => patchForm({ is_active: v })}
                disabled={disabled}
                id="is_active"
              />
              <Label htmlFor="is_active">Agent ativo</Label>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              <strong>Default:</strong> {agent.is_default ? "Sim" : "Não"} (read-only — gerenciado
              pelo backend).
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="model">
          <Card className="space-y-4 p-4">
            <div className="space-y-1">
              <Label>Modelo</Label>
              <Select
                value={formState.model}
                onValueChange={(v) => patchForm({ model: v as AgentModel })}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <SystemPromptEditor
              value={formState.system_prompt}
              onChange={(v) => patchForm({ system_prompt: v })}
              disabled={disabled}
            />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label>Temperature (0–2)</Label>
                <Input
                  type="number"
                  step="0.05"
                  min={0}
                  max={2}
                  value={formState.config.temperature}
                  onChange={(e) => patchConfig({ temperature: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label>Max tokens (64–4096)</Label>
                <Input
                  type="number"
                  step="1"
                  min={64}
                  max={4096}
                  value={formState.config.max_tokens}
                  onChange={(e) => patchConfig({ max_tokens: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label>Janela de contexto (msgs, 1–50)</Label>
                <Input
                  type="number"
                  step="1"
                  min={1}
                  max={50}
                  value={formState.config.context_message_window}
                  onChange={(e) =>
                    patchConfig({ context_message_window: Number(e.target.value) })
                  }
                  disabled={disabled}
                />
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="rag">
          <Card className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label>Top K (1–20)</Label>
                <Input
                  type="number"
                  step="1"
                  min={1}
                  max={20}
                  value={formState.config.rag_top_k}
                  onChange={(e) => patchConfig({ rag_top_k: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label>Similarity threshold (0–1)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  max={1}
                  value={formState.config.rag_similarity_threshold}
                  onChange={(e) =>
                    patchConfig({ rag_similarity_threshold: Number(e.target.value) })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label>Confidence threshold (0–1)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  max={1}
                  value={formState.config.confidence_threshold}
                  onChange={(e) =>
                    patchConfig({ confidence_threshold: Number(e.target.value) })
                  }
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Top K = quantos trechos buscar. Similarity threshold = mínimo de relevância
              (cosine). Confidence = limiar abaixo do qual o agent escala para humano.
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="guardrails">
          <Card className="p-4">
            <GuardrailsEditor
              value={formState.guardrails}
              onChange={(v) => patchForm({ guardrails: v })}
              disabled={disabled}
            />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
