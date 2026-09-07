"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

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
import { useAgentsList } from "@/hooks/ai/useAgents";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { apiClient } from "@/lib/api/client";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

export type ActionItem =
  | { type: "create_or_move_lead"; config: { pipeline_id: string; stage_id: string } }
  | { type: "send_whatsapp_message"; config: { channel_session_id: string; template: string } }
  | {
      type: "send_ai_message";
      config: { agent_id: string; channel_session_id: string; instruction: string };
    }
  | { type: "add_tag"; config: { tags: string[] } }
  | { type: "assign_owner"; config: { user_id: string } }
  | { type: "call_webhook"; config: { url: string; secret?: string; secret_enc?: string } }
  | { type: "start_message_flow"; config: { flow_pointer_id: string } };

export function defaultActionConfig(type: ActionItem["type"]): ActionItem {
  switch (type) {
    case "create_or_move_lead":
      return { type, config: { pipeline_id: "", stage_id: "" } };
    case "send_whatsapp_message":
      return { type, config: { channel_session_id: "", template: "" } };
    case "send_ai_message":
      return { type, config: { agent_id: "", channel_session_id: "", instruction: "" } };
    case "add_tag":
      return { type, config: { tags: [] } };
    case "assign_owner":
      return { type, config: { user_id: "" } };
    case "call_webhook":
      return { type, config: { url: "" } };
    case "start_message_flow":
      return { type, config: { flow_pointer_id: "" } };
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
  const t = useT();
  const { data: pipelinesRes, isLoading: pipelinesLoading } = usePipelines();
  const { data: boardRes, isLoading: stagesLoading } = usePipelineStages(
    config.pipeline_id || null,
  );
  const pipelines = pipelinesRes?.data ?? [];
  const stages = boardRes?.data?.stages ?? [];

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>{t("Funil")}</Label>
        <Select
          value={config.pipeline_id}
          onValueChange={(v) => onChange({ pipeline_id: v, stage_id: "" })}
          disabled={pipelinesLoading}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("Escolha o funil")} />
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
        <Label>{t("Etapa")}</Label>
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
  const t = useT();
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
        <Label>{t("Número de WhatsApp")}</Label>
        <Select
          value={config.channel_session_id}
          onValueChange={(v) => onChange({ ...config, channel_session_id: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("Escolha o número")} />
          </SelectTrigger>
          <SelectContent>
            {(sessions ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id} disabled={s.status !== "WORKING"}>
                {channelLabel(s) + (s.status !== "WORKING" ? " — desconectado" : "")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(sessions ?? []).some((s) => s.status !== "WORKING") ? (
          <p className="text-xs text-muted-foreground">
            {t("Números desconectados aparecem desabilitados — reconecte em Conexões antes de usar.")}
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label>{t("Mensagem")}</Label>
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
          {/* NÃO cravar "7h e 22h": a janela passou a vir dos ajustes DO NÚMERO
              (Conexões), no fuso da sua organização, e quem a mudou lá veria a
              tela continuar prometendo outro horário. Rótulo visível é contrato. */}
          {t("Respeitamos a janela de envio e o limite diário configurados para esse número em Conexões — fora da janela, a mensagem espera a próxima.")}
        </p>
      </div>
    </div>
  );
}

/**
 * "Mensagem escrita pela IA" — o agente publicado lê o formulário e escreve.
 *
 * Três campos e uma ordem deliberada: QUEM escreve (o agente, que carrega o
 * tom e o conhecimento do negócio), POR ONDE sai (o número), e — o campo que
 * faz a diferença — O QUE FAZER com o que a pessoa preencheu.
 *
 * Esse terceiro campo é o mesmo desenho do "Instrução para a IA" de um passo de
 * follow-up. Sem ele o agente receberia um punhado de dados e nenhuma tarefa, e
 * escreveria o genérico que qualquer IA escreve. Os exemplos abaixo do campo
 * não são enfeite: eles mostram o NÍVEL de instrução que funciona, que é a
 * dúvida real de quem nunca escreveu prompt.
 */
function SendAiMessageForm({
  config,
  onChange,
}: FormProps<{ agent_id: string; channel_session_id: string; instruction: string }>) {
  const t = useT();
  const { data: agentes } = useAgentsList();
  const { data: sessions } = useChannelSessions();
  const publicados = (agentes ?? []).filter((a) => Boolean(a.published_version_id));
  const semPublicado = (agentes ?? []).length > 0 && publicados.length === 0;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t("Qual agente escreve")}</Label>
        <Select
          value={config.agent_id}
          onValueChange={(v) => onChange({ ...config, agent_id: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("Escolha o agente")} />
          </SelectTrigger>
          <SelectContent>
            {(agentes ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id} disabled={!a.published_version_id}>
                {a.name + (a.published_version_id ? "" : t(" — não publicado"))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {semPublicado
            ? t("Nenhum agente está publicado. Publique um em Agentes de IA para poder usá-lo aqui.")
            : t("Ele escreve com o mesmo tom e o mesmo conhecimento que usa no atendimento.")}
        </p>
      </div>

      <div className="space-y-1">
        <Label>{t("Número de WhatsApp")}</Label>
        <Select
          value={config.channel_session_id}
          onValueChange={(v) => onChange({ ...config, channel_session_id: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("Escolha o número")} />
          </SelectTrigger>
          <SelectContent>
            {(sessions ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id} disabled={s.status !== "WORKING"}>
                {channelLabel(s) + (s.status !== "WORKING" ? " — desconectado" : "")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ai-instruction">{t("O que a IA deve fazer com os dados")}</Label>
        <Textarea
          id="ai-instruction"
          rows={4}
          maxLength={1000}
          value={config.instruction}
          onChange={(e) => onChange({ ...config, instruction: e.target.value })}
          placeholder={
            "Ex.: Agradeça o interesse citando o segmento que a pessoa informou, mostre em uma frase " +
            "como a gente resolve a dificuldade que ela descreveu, e pergunte qual o melhor horário para conversar."
          }
        />
        <p className="text-xs text-muted-foreground">
          {t("O agente já sabe que é a PRIMEIRA mensagem, logo depois de a pessoa preencher o formulário, e recebe todos os campos que ela respondeu. Aqui você diz o que fazer com eles — quanto mais concreto, melhor a mensagem.")}
        </p>
      </div>
    </div>
  );
}

function AddTagForm({ config, onChange }: FormProps<{ tags: string[] }>) {
  const t = useT();
  const [text, setText] = React.useState(config.tags.join(", "));
  return (
    <div className="space-y-1">
      <Label>{t("Tags (separadas por vírgula)")}</Label>
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
  const t = useT();
  const { data: members } = useAssignableMembers(true);
  return (
    <div className="space-y-1">
      <Label>{t("Atendente")}</Label>
      <Select value={config.user_id} onValueChange={(v) => onChange({ user_id: v })}>
        <SelectTrigger>
          <SelectValue placeholder={t("Escolha o atendente")} />
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

function CallWebhookForm({
  config,
  onChange,
}: FormProps<{ url: string; secret?: string; secret_enc?: string }>) {
  const t = useT();
  // O segredo é write-only: o servidor guarda cifrado (secret_enc) e nunca
  // devolve o valor. Digitar aqui envia `secret` novo; deixar em branco
  // preserva o secret_enc existente no round-trip do editor.
  const hasStoredSecret = Boolean(config.secret_enc) && !config.secret;
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{t("Endereço (URL)")}</Label>
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
          type="password"
          value={config.secret ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            // Digitou algo novo → substitui; limpou → remove o guardado também.
            const { secret_enc: _enc, ...rest } = config;
            onChange(next ? { ...rest, secret: next } : { ...rest, secret: undefined });
          }}
          placeholder={hasStoredSecret ? "•••••••• (definido — digite para trocar)" : "uma senha só sua"}
        />
        <p className="text-xs text-muted-foreground">
          {hasStoredSecret
            ? t("Já existe um segredo guardado com segurança. Digitar aqui substitui; limpar remove.")
            : t("Se preencher, enviaremos uma assinatura para o outro sistema conferir que fomos nós.")}
        </p>
      </div>
    </div>
  );
}

function StartMessageFlowForm({ config, onChange }: FormProps<{ flow_pointer_id: string }>) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ["followup", "flows", "list"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: FollowupFlowPointerRow[] }>(
        "/api/v1/ai/followup-flows",
      );
      return res.data;
    },
  });
  const active = (data ?? []).filter((f) => f.status === "active");

  return (
    <div className="space-y-1">
      <Label>{t("Fluxo de follow-up")}</Label>
      <Select
        value={config.flow_pointer_id}
        onValueChange={(v) => onChange({ flow_pointer_id: v })}
        disabled={isLoading}
      >
        <SelectTrigger>
          <SelectValue placeholder={t("Escolha um fluxo publicado")} />
        </SelectTrigger>
        <SelectContent>
          {active.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!isLoading && active.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Nenhum fluxo ativo. Publique um follow-up em Follow-ups para usá-lo aqui.")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("Só entram fluxos publicados e ativos.")}
        </p>
      )}
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
    case "send_ai_message":
      return (
        <SendAiMessageForm
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
    case "start_message_flow":
      return (
        <StartMessageFlowForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
  }
}
