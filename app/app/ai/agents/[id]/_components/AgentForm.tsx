"use client";
/**
 * Form principal de configuração de um mcp_agent (Spec 12 §3 / S-13.11).
 *
 * Renderiza o agent + sua draft mais recente. Carregamento inicial vem do
 * Server Component pai (initial props). Mutations passam por:
 *   - `saveAgentDraftAction` (cria draft nova ou PATCH na existente)
 *   - `publishAgentAction` (versão draft → published; flip atômico via fn)
 *
 * Estados visíveis ao usuário:
 *   - "Publicado vN" (sem draft, valores espelham published)
 *   - "Rascunho vN+1" (sem published)
 *   - "Publicado vN + Rascunho vM" (formulário mostra a draft)
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TokenCounter } from "@/lib/ui/TokenCounter";

import { ModelPicker, useModelMeta } from "./ModelPicker";
import { CredentialPicker, findCredential } from "./CredentialPicker";
import { ToolPicker } from "./ToolPicker";
import { TriggerEditor, type TriggerValue } from "./TriggerEditor";
import { HandoffKeywordsInput } from "./HandoffKeywordsInput";
import { FollowupFlowPicker } from "./FollowupFlowPicker";
import { PublishConfirmDialog } from "./PublishConfirmDialog";
import {
  saveAgentDraftAction,
  publishAgentAction,
  createMcpAgentAction,
} from "../_actions";

import { versionCreateSchema, agentMcpCreateSchema } from "@/lib/ai/agents/validation";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import type { CredentialRow, Provider } from "@/hooks/ai/useCredentials";
import { credentialStatus } from "@/hooks/ai/useCredentials";

export interface ChannelSessionLite {
  id: string;
  display_name: string;
  status: string;
  phone_number: string | null;
}

interface BaseProps {
  credentials: CredentialRow[];
  channelSessions: ChannelSessionLite[];
  readOnly?: boolean;
}

interface EditProps extends BaseProps {
  mode: "edit";
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
}

interface CreateProps extends BaseProps {
  mode: "create";
}

type Props = EditProps | CreateProps;

interface FormState {
  name: string;
  description: string;
  priority: number;
  provider: Provider;
  model: string;
  credential_id: string;
  channel_session_id: string;
  system_prompt: string;
  tool_ids: string[];
  trigger_config: TriggerValue;
  max_steps: number;
  token_budget: number;
  cost_budget_cents: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[];
  handoff_tool_enabled: boolean;
  followup: FollowupValue;
}

interface FollowupValue {
  enabled: boolean;
  flow_pointer_ids: string[];
}

const DEFAULT_FOLLOWUP: FollowupValue = { enabled: false, flow_pointer_ids: [] };

const DEFAULT_TRIGGER: TriggerValue = {
  events: ["message"],
  filters: {
    ignore_groups: true,
    ignore_self: true,
    keyword_regex: null,
    business_hours: null,
  },
  concurrency: "one_per_conversation",
};

function buildState(args: {
  agent?: AgentRow;
  version: AgentVersionRow | null;
}): FormState {
  const { agent, version } = args;
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    priority: agent?.priority ?? 0,
    provider: (version?.provider as Provider) ?? "anthropic",
    model: version?.model ?? "",
    credential_id: version?.credential_id ?? "",
    channel_session_id: version?.channel_session_id ?? "",
    system_prompt:
      version?.system_prompt ??
      "Você é um atendente. Responda de forma educada e clara, em pt-BR.",
    tool_ids: version?.tool_ids ?? [],
    trigger_config: (version?.trigger_config as unknown as TriggerValue) ?? DEFAULT_TRIGGER,
    max_steps: version?.max_steps ?? 10,
    token_budget: version?.token_budget ?? 50_000,
    cost_budget_cents: version?.cost_budget_cents ?? 50,
    history_message_window: version?.history_message_window ?? 20,
    history_token_window: version?.history_token_window ?? 8_000,
    handoff_keywords: version?.handoff_keywords ?? [
      "falar com humano",
      "atendente",
      "pessoa real",
    ],
    handoff_tool_enabled: version?.handoff_tool_enabled ?? true,
    followup: version?.followup ?? DEFAULT_FOLLOWUP,
  };
}

function toVersionPayload(s: FormState) {
  return {
    system_prompt: s.system_prompt,
    provider: s.provider,
    model: s.model,
    credential_id: s.credential_id,
    tool_ids: s.tool_ids,
    trigger_config: s.trigger_config,
    channel_session_id: s.channel_session_id,
    max_steps: s.max_steps,
    token_budget: s.token_budget,
    cost_budget_cents: s.cost_budget_cents,
    history_message_window: s.history_message_window,
    history_token_window: s.history_token_window,
    handoff_keywords: s.handoff_keywords,
    handoff_tool_enabled: s.handoff_tool_enabled,
    followup: s.followup,
  };
}

export function AgentForm(props: Props) {
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const readOnly = props.readOnly ?? false;

  const baseline = React.useMemo(() => {
    if (isEdit) {
      const ref = props.draft ?? props.published;
      return buildState({ agent: props.agent, version: ref });
    }
    return buildState({ version: null });
  }, [isEdit, props]);

  const [form, setForm] = React.useState<FormState>(baseline);
  const [saving, setSaving] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  function patch(p: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  // Quando provider muda, limpa credential e modelo (eles dependem do provider).
  function changeProvider(p: Provider) {
    patch({ provider: p, credential_id: "", model: "" });
  }

  const cred = findCredential(props.credentials, form.credential_id);
  const credSt = cred ? credentialStatus(cred) : null;
  const channelSession = props.channelSessions.find((c) => c.id === form.channel_session_id);
  const modelMeta = useModelMeta(form.provider, form.model);

  // ---------------------------------------------------------------------
  // Validação (espelha versionCreateSchema, no client; server revalida).
  // ---------------------------------------------------------------------
  const validation = React.useMemo(() => {
    const errors: Record<string, string> = {};
    if (form.name.trim().length === 0) errors.name = "Nome obrigatório.";
    if (form.name.length > 120) errors.name = "Nome até 120 caracteres.";
    if (form.system_prompt.trim().length < 10)
      errors.system_prompt = "Prompt mínimo de 10 caracteres.";
    if (form.system_prompt.length > 20000)
      errors.system_prompt = "Prompt máximo de 20.000 caracteres.";
    if (!form.model) errors.model = "Selecione um modelo.";
    if (!form.credential_id) errors.credential_id = "Selecione uma credencial.";
    if (!form.channel_session_id)
      errors.channel_session_id = "Selecione um número de WhatsApp.";
    if (form.tool_ids.length > 20) errors.tool_ids = "Máximo de 20 tools.";

    // Tenta o schema completo:
    if (Object.keys(errors).length === 0) {
      const parsed = versionCreateSchema.safeParse(toVersionPayload(form));
      if (!parsed.success) {
        const flat = parsed.error.flatten();
        const first = Object.entries(flat.fieldErrors)[0];
        if (first) errors[first[0]] = first[1]?.[0] ?? "Campo inválido.";
      }
    }
    return errors;
  }, [form]);

  const isValid = Object.keys(validation).length === 0;

  const publishBlockReason = React.useMemo(() => {
    if (!isEdit) return "Salve o agent antes de publicar.";
    if (!props.draft) return "Sem rascunho para publicar.";
    if (!isValid) return "Resolva os erros do formulário.";
    if (dirty) return "Salve o rascunho antes de publicar.";
    if (!cred) return "Selecione uma credencial.";
    if (credSt !== "validated")
      return `Credencial ${form.provider} ${credSt === "invalid" ? "inválida" : "ainda não validada"}.`;
    if (!channelSession) return "Selecione um número de WhatsApp.";
    if (channelSession.status !== "working" && channelSession.status !== "WORKING")
      return `Número WhatsApp não está conectado (status: ${channelSession.status}).`;
    return null;
  }, [isEdit, props, isValid, dirty, cred, credSt, form.provider, channelSession]);

  // ---------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------

  async function handleSave() {
    if (!isValid) {
      const first = Object.values(validation)[0];
      toast.error(first ?? "Formulário inválido.");
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        const res = await saveAgentDraftAction(props.agent.id, toVersionPayload(form));
        if (!res.ok) {
          toast.error(res.message ?? `Erro: ${res.error}`);
          return;
        }
        toast.success(`Rascunho v${res.data!.version_number} salvo.`);
        router.refresh();
      } else {
        const payload = {
          name: form.name,
          description: form.description.trim() === "" ? undefined : form.description,
          priority: form.priority,
          version: toVersionPayload(form),
        };
        const validated = agentMcpCreateSchema.safeParse(payload);
        if (!validated.success) {
          toast.error("Validação falhou.");
          return;
        }
        const res = await createMcpAgentAction(validated.data);
        if (!res.ok) {
          toast.error(res.message ?? `Erro: ${res.error}`);
          return;
        }
        toast.success("Agent criado.");
        router.push(`/app/ai/agents/${res.data!.agent_id}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!isEdit || !props.draft) return;
    setPublishing(true);
    try {
      const res = await publishAgentAction(props.agent.id, props.draft.id);
      if (!res.ok) {
        toast.error(`Falha ao publicar: ${res.error}`);
        return;
      }
      toast.success(`v${props.draft.version_number} publicada e ativa.`);
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPublishing(false);
    }
  }

  function handleReset() {
    setForm(baseline);
  }

  const disabled = readOnly || saving || publishing;

  // Status badge
  const statusBadge = (() => {
    if (!isEdit) return <Badge variant="secondary">Novo</Badge>;
    const pubN = props.published?.version_number;
    const draftN = props.draft?.version_number;
    if (pubN && draftN) {
      return (
        <Badge variant="secondary">
          Publicado v{pubN} + Rascunho v{draftN}
        </Badge>
      );
    }
    if (pubN) return <Badge variant="default">Publicado v{pubN}</Badge>;
    if (draftN) return <Badge variant="outline">Rascunho v{draftN}</Badge>;
    return <Badge variant="outline">Sem versão</Badge>;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {isEdit ? props.agent.name : "Novo agent"}
            </h2>
            {statusBadge}
          </div>
          {isEdit && props.agent.description ? (
            <p className="text-xs text-muted-foreground">{props.agent.description}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isEdit ? (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!dirty || disabled}
            >
              Descartar alterações
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={(!dirty && isEdit) || disabled || !isValid}>
            {saving ? "Salvando…" : isEdit ? "Salvar rascunho" : "Criar agent"}
          </Button>
          {isEdit ? (
            <span title={publishBlockReason ?? undefined}>
              <Button
                variant="default"
                onClick={() => setConfirmOpen(true)}
                disabled={disabled || publishBlockReason !== null}
              >
                {publishing
                  ? "Publicando…"
                  : props.draft
                    ? `Publicar v${props.draft.version_number}`
                    : "Publicar"}
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* COLUMN 1 */}
        <div className="space-y-4">
          {/* Identification */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Identificação</h3>
            <div className="space-y-1">
              <Label htmlFor="name">Nome</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={disabled}
                maxLength={120}
                aria-invalid={!!validation.name}
              />
              {validation.name ? (
                <p className="text-xs text-destructive">{validation.name}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Descrição</Label>
              <Textarea
                id="description"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                disabled={disabled}
                rows={2}
                maxLength={2000}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="priority">Prioridade (0–1000)</Label>
              <Input
                id="priority"
                type="number"
                min={0}
                max={1000}
                step={1}
                value={form.priority}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Maior prioridade = avaliado primeiro pelo dispatcher.
              </p>
            </div>
          </Card>

          {/* Provider + credential + model */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Modelo & credencial</h3>
            <div className="space-y-1">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={form.provider}
                onValueChange={(v) => changeProvider(v as Provider)}
                disabled={disabled}
              >
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="google">Google (Gemini)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <ModelPicker
              provider={form.provider}
              value={form.model}
              onChange={(modelId) => patch({ model: modelId })}
              disabled={disabled}
              id="model"
            />
            {validation.model ? (
              <p className="text-xs text-destructive">{validation.model}</p>
            ) : null}

            <CredentialPicker
              provider={form.provider}
              credentials={props.credentials}
              value={form.credential_id}
              onChange={(id) => patch({ credential_id: id })}
              disabled={disabled}
              id="credential_id"
            />
            {validation.credential_id ? (
              <p className="text-xs text-destructive">{validation.credential_id}</p>
            ) : null}
            {cred && credSt !== "validated" ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Credencial selecionada está com status {credSt}. Publish bloqueado até validar.
              </p>
            ) : null}
          </Card>

          {/* WhatsApp session */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Número de WhatsApp</h3>
            <div className="space-y-1">
              <Label htmlFor="channel_session_id">Sessão</Label>
              <Select
                value={form.channel_session_id || undefined}
                onValueChange={(v) => patch({ channel_session_id: v })}
                disabled={disabled}
              >
                <SelectTrigger id="channel_session_id">
                  <SelectValue placeholder="Selecione um número" />
                </SelectTrigger>
                <SelectContent>
                  {props.channelSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.display_name}
                      {s.phone_number ? ` · ${s.phone_number}` : ""} · {s.status}
                    </SelectItem>
                  ))}
                  {props.channelSessions.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      Nenhum número conectado
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
              {validation.channel_session_id ? (
                <p className="text-xs text-destructive">{validation.channel_session_id}</p>
              ) : null}
            </div>
          </Card>

          {/* Limits */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Limites</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="max_steps">Max steps (1–25)</Label>
                <Input
                  id="max_steps"
                  type="number"
                  min={1}
                  max={25}
                  value={form.max_steps}
                  onChange={(e) => patch({ max_steps: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="token_budget">Token budget</Label>
                <Input
                  id="token_budget"
                  type="number"
                  min={1000}
                  max={500000}
                  step={1000}
                  value={form.token_budget}
                  onChange={(e) => patch({ token_budget: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cost_budget_cents">Custo máx (cents)</Label>
                <Input
                  id="cost_budget_cents"
                  type="number"
                  min={1}
                  max={10000}
                  value={form.cost_budget_cents}
                  onChange={(e) => patch({ cost_budget_cents: Number(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="history_message_window">Histórico (msgs)</Label>
                <Input
                  id="history_message_window"
                  type="number"
                  min={0}
                  max={200}
                  value={form.history_message_window}
                  onChange={(e) =>
                    patch({ history_message_window: Number(e.target.value) })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor="history_token_window">Histórico (tokens)</Label>
                <Input
                  id="history_token_window"
                  type="number"
                  min={0}
                  max={50000}
                  step={500}
                  value={form.history_token_window}
                  onChange={(e) =>
                    patch({ history_token_window: Number(e.target.value) })
                  }
                  disabled={disabled}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* COLUMN 2 */}
        <div className="space-y-4">
          {/* Prompt */}
          <Card className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">System prompt</h3>
              <TokenCounter
                text={form.system_prompt}
                contextWindow={modelMeta?.context_window ?? null}
                className="text-xs"
              />
            </div>
            <Textarea
              value={form.system_prompt}
              onChange={(e) => patch({ system_prompt: e.target.value })}
              disabled={disabled}
              rows={12}
              maxLength={20000}
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={!!validation.system_prompt}
            />
            {validation.system_prompt ? (
              <p className="text-xs text-destructive">{validation.system_prompt}</p>
            ) : null}
          </Card>

          {/* Tools */}
          <Card className="space-y-2 p-4">
            <h3 className="text-sm font-medium">Tools (catálogo MCP)</h3>
            <ToolPicker
              value={form.tool_ids}
              onChange={(ids) => patch({ tool_ids: ids })}
              disabled={disabled}
            />
            {validation.tool_ids ? (
              <p className="text-xs text-destructive">{validation.tool_ids}</p>
            ) : null}
          </Card>

          {/* Triggers */}
          <Card className="space-y-2 p-4">
            <h3 className="text-sm font-medium">Gatilhos</h3>
            <TriggerEditor
              value={form.trigger_config}
              onChange={(v) => patch({ trigger_config: v })}
              disabled={disabled}
            />
          </Card>

          {/* Handoff */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Handoff humano</h3>
            <div className="flex items-center gap-2">
              <Switch
                id="handoff_tool_enabled"
                checked={form.handoff_tool_enabled}
                onCheckedChange={(v) => patch({ handoff_tool_enabled: v })}
                disabled={disabled}
              />
              <Label htmlFor="handoff_tool_enabled">
                Permitir handoff via tool (decisão do agent)
              </Label>
            </div>
            <HandoffKeywordsInput
              value={form.handoff_keywords}
              onChange={(v) => patch({ handoff_keywords: v })}
              disabled={disabled}
            />
          </Card>

          {/* Follow-up */}
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-medium">Follow-up</h3>
            <div className="flex items-center gap-2">
              <Switch
                id="followup_enabled"
                checked={form.followup.enabled}
                onCheckedChange={(v) =>
                  patch({ followup: { ...form.followup, enabled: v } })
                }
                disabled={disabled}
              />
              <Label htmlFor="followup_enabled">
                Habilitar gatilhos automáticos de follow-up
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Gatilhos de silêncio/etapa só enrollam um lead num fluxo abaixo se
              este agente estiver publicado com follow-up habilitado.
            </p>
            <FollowupFlowPicker
              value={form.followup.flow_pointer_ids}
              onChange={(ids) =>
                patch({ followup: { ...form.followup, flow_pointer_ids: ids } })
              }
              disabled={disabled}
            />
          </Card>
        </div>
      </div>

      {/* Publish dialog */}
      {isEdit && props.draft ? (
        <PublishConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          draft={props.draft}
          published={props.published}
          onConfirm={handlePublish}
          isPending={publishing}
        />
      ) : null}
    </div>
  );
}
