"use client";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";

export type ActionItem =
  | { type: "create_or_move_lead"; config: { pipeline_id: string; stage_id: string } }
  | { type: "send_whatsapp_message"; config: { channel_session_id: string; template: string } }
  | { type: "add_tag"; config: { tags: string[] } }
  | { type: "assign_owner"; config: { user_id: string } }
  | { type: "call_webhook"; config: { url: string; secret?: string } };

export function defaultActionConfig(type: ActionItem["type"]): ActionItem {
  switch (type) {
    case "create_or_move_lead":
      return { type, config: { pipeline_id: "", stage_id: "" } };
    case "send_whatsapp_message":
      return { type, config: { channel_session_id: "", template: "" } };
    case "add_tag":
      return { type, config: { tags: [] } };
    case "assign_owner":
      return { type, config: { user_id: "" } };
    case "call_webhook":
      return { type, config: { url: "", secret: "" } };
  }
}

interface FormProps<T> {
  config: T;
  onChange: (config: T) => void;
}

function CreateOrMoveLeadForm({
  config,
  onChange,
}: FormProps<{ pipeline_id: string; stage_id: string }>) {
  const { data: pipelinesRes, isLoading: pipelinesLoading } = usePipelines();
  const { data: boardRes, isLoading: stagesLoading } = usePipelineStages(
    config.pipeline_id || null,
  );
  const pipelines = pipelinesRes?.data ?? [];
  const stages = boardRes?.data?.stages ?? [];

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>Funil</Label>
        <Select
          value={config.pipeline_id}
          onValueChange={(v) => onChange({ pipeline_id: v, stage_id: "" })}
          disabled={pipelinesLoading}
        >
          <SelectTrigger>
            <SelectValue placeholder="Escolha o funil" />
          </SelectTrigger>
          <SelectContent>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Etapa</Label>
        <Select
          value={config.stage_id}
          onValueChange={(v) => onChange({ ...config, stage_id: v })}
          disabled={!config.pipeline_id || stagesLoading}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={config.pipeline_id ? "Escolha a etapa" : "Escolha o funil primeiro"}
            />
          </SelectTrigger>
          <SelectContent>
            {stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

const TEMPLATE_VARS = [
  { token: "{{nome}}", label: "Nome" },
  { token: "{{telefone}}", label: "Telefone" },
  { token: "{{lead.title}}", label: "Título do lead" },
];

function SendWhatsappForm({
  config,
  onChange,
}: FormProps<{ channel_session_id: string; template: string }>) {
  const { data: sessions } = useChannelSessions();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const insertVar = (token: string) => {
    const el = textareaRef.current;
    const current = config.template;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange({ ...config, template: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>Número de WhatsApp</Label>
        <Select
          value={config.channel_session_id}
          onValueChange={(v) => onChange({ ...config, channel_session_id: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Escolha o número" />
          </SelectTrigger>
          <SelectContent>
            {(sessions ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id} disabled={s.status !== "WORKING"}>
                {(s.display_name ?? s.waha_session_name) +
                  (s.status !== "WORKING" ? " — desconectado" : "")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(sessions ?? []).some((s) => s.status !== "WORKING") ? (
          <p className="text-xs text-muted-foreground">
            Números desconectados aparecem desabilitados — reconecte em Conexões antes de usar.
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label>Mensagem</Label>
        <div className="flex flex-wrap gap-1">
          {TEMPLATE_VARS.map((v) => (
            <Button
              key={v.token}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => insertVar(v.token)}
            >
              {v.label}
            </Button>
          ))}
        </div>
        <Textarea
          ref={textareaRef}
          rows={4}
          value={config.template}
          onChange={(e) => onChange({ ...config, template: e.target.value })}
          placeholder="Oi {{nome}}, tudo bem?"
        />
        <p className="text-xs text-muted-foreground">
          Enviamos só entre 7h e 22h e respeitamos o limite diário do número — fora disso a
          mensagem espera a próxima janela.
        </p>
      </div>
    </div>
  );
}

function AddTagForm({ config, onChange }: FormProps<{ tags: string[] }>) {
  const [text, setText] = React.useState(config.tags.join(", "));
  return (
    <div className="space-y-1">
      <Label>Tags (separadas por vírgula)</Label>
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const tags = e.target.value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          onChange({ tags });
        }}
        placeholder="boas-vindas, novo-lead"
      />
    </div>
  );
}

function AssignOwnerForm({ config, onChange }: FormProps<{ user_id: string }>) {
  const { data: members } = useAssignableMembers(true);
  return (
    <div className="space-y-1">
      <Label>Atendente</Label>
      <Select value={config.user_id} onValueChange={(v) => onChange({ user_id: v })}>
        <SelectTrigger>
          <SelectValue placeholder="Escolha o atendente" />
        </SelectTrigger>
        <SelectContent>
          {(members ?? []).map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.full_name ?? m.user_id.slice(0, 8)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CallWebhookForm({ config, onChange }: FormProps<{ url: string; secret?: string }>) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>Endereço (URL)</Label>
        <Input
          type="url"
          value={config.url}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
          placeholder="https://meusistema.com/webhook"
        />
      </div>
      <div className="space-y-1">
        <Label>Segredo (opcional)</Label>
        <Input
          value={config.secret ?? ""}
          onChange={(e) => onChange({ ...config, secret: e.target.value })}
          placeholder="uma senha só sua"
        />
        <p className="text-xs text-muted-foreground">
          Se preencher, enviaremos uma assinatura para o outro sistema conferir que fomos nós.
        </p>
      </div>
    </div>
  );
}

export function ActionConfigForm({
  action,
  onChange,
}: {
  action: ActionItem;
  onChange: (next: ActionItem) => void;
}) {
  switch (action.type) {
    case "create_or_move_lead":
      return (
        <CreateOrMoveLeadForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "send_whatsapp_message":
      return (
        <SendWhatsappForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "add_tag":
      return (
        <AddTagForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "assign_owner":
      return (
        <AssignOwnerForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "call_webhook":
      return (
        <CallWebhookForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
  }
}
