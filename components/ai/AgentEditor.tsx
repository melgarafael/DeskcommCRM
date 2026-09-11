"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
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
import { useT } from "@/hooks/i18n/useT";
import {
  AGENT_CONFIG_DEFAULTS,
  AGENT_MODELS,
  AGENT_VOICE_OPTIONS,
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
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
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
    return <p className="text-sm text-muted-foreground">{t("Carregando agent…")}</p>;
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
        Object.values(flat.fieldErrors)[0]?.[0] ?? flat.formErrors[0] ?? t("Guardrails inválidos.");
      toast.error(`${t("Guardrails inválidos")}: ${firstErr}`);
      return;
    }

    const patch = diffPatch(baselineState, formState);
    if (Object.keys(patch).length === 0) {
      toast.info(t("Nada para salvar."));
      return;
    }

    const validated = agentPatchSchema.safeParse(patch);
    if (!validated.success) {
      const flat = validated.error.flatten();
      const firstErr =
        Object.values(flat.fieldErrors)[0]?.[0] ?? flat.formErrors[0] ?? t("Campos inválidos.");
      toast.error(`${t("Erro ao salvar")}: ${firstErr}`);
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
            {agent.is_default ? `${t("Agent default")} · ` : ""}
            {t("Criado em")} {new Date(agent.created_at).toLocaleDateString(tagDoIdioma)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={!dirty || disabled}>
            {t("Descartar")}
          </Button>
          <Button onClick={handleSave} disabled={!dirty || disabled}>
            {update.isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t("Geral")}</TabsTrigger>
          <TabsTrigger value="model">{t("Modelo")}</TabsTrigger>
          <TabsTrigger value="rag">RAG</TabsTrigger>
          {agent.channel === "voice" && <TabsTrigger value="voz">{t("Voz")}</TabsTrigger>}
          <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card className="space-y-4 p-4">
            <div className="space-y-1">
              <Label htmlFor="name">{t("Nome")}</Label>
              <Input
                id="name"
                value={formState.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                disabled={disabled}
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">{t("Descrição")}</Label>
              <Textarea
                id="description"
                value={formState.description}
                onChange={(e) => patchForm({ description: e.target.value })}
                disabled={disabled}
                rows={3}
                maxLength={500}
                placeholder={t("Descrição interna do agent")}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={formState.is_active}
                onCheckedChange={(v) => patchForm({ is_active: v })}
                disabled={disabled}
                id="is_active"
              />
              <Label htmlFor="is_active">{t("Agent ativo")}</Label>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              <strong>{t("Default:")}</strong> {agent.is_default ? t("Sim") : t("Não")} ({t("read-only — gerenciado pelo backend")}).
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="model">
          <Card className="space-y-4 p-4">
            <div className="space-y-1">
              <Label>{t("Modelo")}</Label>
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
                <Label>{t("Janela de contexto (msgs, 1–50)")}</Label>
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
              {t(
                "Top K = quantos trechos buscar. Similarity threshold = mínimo de relevância (cosine). Confidence = limiar abaixo do qual o agent escala para humano.",
              )}
            </p>
          </Card>
        </TabsContent>

        {agent.channel === "voice" && (
          <TabsContent value="voz">
            <Card className="space-y-4 p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t("Voz do modelo")}</Label>
                  <Select
                    value={formState.config.voice}
                    onValueChange={(v) => patchConfig({ voice: v as AgentConfig["voice"] })}
                    disabled={disabled}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_VOICE_OPTIONS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{t("Velocidade da fala (0,25–1,5)")}</Label>
                  <Input
                    type="number"
                    step="0.05"
                    min={0.25}
                    max={1.5}
                    value={formState.config.voice_speed}
                    onChange={(e) => patchConfig({ voice_speed: Number(e.target.value) })}
                    disabled={disabled}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "1,0 é a velocidade padrão do modelo — abaixo disso fala mais devagar, acima fala mais rápido. Vale a partir da próxima ligação.",
                )}
              </p>
            </Card>
          </TabsContent>
        )}

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
