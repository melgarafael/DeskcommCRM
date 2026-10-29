"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { apiClient } from "@/lib/api/client";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  followupFlowsListQueryKey,
  type FollowupFlowPointerRow,
} from "@/hooks/followup/useFollowupFlows";
import type { PlanoDeTarefas } from "@/lib/tarefas/plano";
import { CaretDown, CaretUp, Pause, Play, X } from "@/lib/ui/icons";

/**
 * #2041 — uma pessoa fixa (a forma de sempre, sem `modo`) ou um rodízio, em que
 * a posição na `fila` é a ordem. Mesma forma do `configDoAtribuirSchema` da API.
 */
export type ConfigDoAtribuir =
  | { modo?: "fixo"; user_id: string }
  | { modo: "rodizio"; fila: Array<{ user_id: string; pausado: boolean }> };

export type ActionItem =
  | { type: "create_or_move_lead"; config: { pipeline_id: string; stage_id: string } }
  | {
      type: "send_whatsapp_message";
      config: { channel_session_id: string; template: string; media_url?: string | null };
    }
  // #2726 — o e-mail de saída: mesmo campo que a irmã de WhatsApp (`assunto`/
  // `corpo` no lugar do `template`), e `email_fixo` só preenche quando o
  // destinatário é o endereço gravado na regra. `membro_id` só preenche no
  // destinatário "membro da equipe" (#2642, recorte do PR #2834).
  | {
      type: "send_email";
      config: {
        destinatario: "contato" | "dono_do_lead" | "membro_da_equipe" | "fixo";
        email_fixo: string;
        membro_id: string;
        assunto: string;
        corpo: string;
        formato: string;
      };
    }
  | {
      type: "send_ai_message";
      config: { agent_id: string; channel_session_id: string; instruction: string };
    }
  | {
      type: "add_tag";
      config: { tags: string[]; destino?: "card" | "contato" };
    }
  | { type: "assign_owner"; config: ConfigDoAtribuir }
  | { type: "call_webhook"; config: { url: string; secret?: string; secret_enc?: string; include_owner?: boolean } }
  | {
      type: "start_message_flow";
      config: { flow_pointer_id: string; surface?: "followup" | "atendimento" };
    }
  // #1540 — o lembrete interno: mesmos campos do schema da API e do nó de fluxo.
  | {
      type: "create_task";
      config: {
        titulo: string;
        vence_em_dias: number;
        atribuir_a: "dono_do_lead" | { usuario_id: string };
        prioridade: string;
      };
    }
  // #1752 — a SEQUÊNCIA: o plano mora em `organizations.settings.task_plans`,
  // e o editor só escolhe QUAL deles aplicar. `plano_id` é o id do JSON (não
  // uuid) — mesmos campos do schema da API e da ação `apply_task_plan`.
  | { type: "apply_task_plan"; config: { plano_id: string } }
  // #2642 — o destino é o WhatsApp que o ADMIN já registrou em Avisos. Por
  // isso não existe campo de número, de endereço, de pessoa nem de canal: a
  // configuração guarda só o canal, e é o executor que lê o destino
  // cadastrado. Mesmos campos do schema da API.
  | { type: "notify_team"; config: { canal: "whatsapp" } };

export function defaultActionConfig(type: ActionItem["type"]): ActionItem {
  switch (type) {
    case "create_or_move_lead":
      return { type, config: { pipeline_id: "", stage_id: "" } };
    case "send_whatsapp_message":
      return { type, config: { channel_session_id: "", template: "" } };
    // #2726 — o e-mail de saída: a MESMA forma que o schema da API exige
    // (`formato` sempre presente, porque a tela desenha a escolha).
    case "send_email":
      return {
        type,
        config: {
          destinatario: "contato",
          email_fixo: "",
          membro_id: "",
          assunto: "",
          corpo: "",
          formato: "texto",
        },
      };
    case "send_ai_message":
      return { type, config: { agent_id: "", channel_session_id: "", instruction: "" } };
    case "add_tag":
      return { type, config: { tags: [] } };
    case "assign_owner":
      return { type, config: { user_id: "" } };
    case "call_webhook":
      return { type, config: { url: "" } };
    case "start_message_flow":
      // #2647 — o padrão é follow-up, o comportamento de sempre; `atendimento`
      // é a opção que quem monta a regra escolhe, e só ela muda o caminho.
      return { type, config: { flow_pointer_id: "", surface: "followup" } };
    // #1540 — o lembrete interno: mesma forma que o schema da API exige.
    case "create_task":
      return {
        type,
        config: { titulo: "", vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "medium" },
      };
    case "apply_task_plan":
      return { type, config: { plano_id: "" } };
    // #2642 — o destino é o WhatsApp que o ADMIN cadastrou em Avisos, e só
    // ele: depois do recorte do PR #2834 não há pessoa nem canal a escolher, e
    // por isso o `config` guarda apenas o canal (o schema exige o literal).
    case "notify_team":
      return { type, config: { canal: "whatsapp" } };
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
              placeholder={config.pipeline_id ? t("Escolha a etapa") : t("Escolha o funil primeiro")}
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

// O rótulo de cada variável é chave do dicionário e passa por t() onde vira botão: escrito cru, ele saía em
// português em todo idioma. Só estas três: os campos do formulário que vêm junto são rótulos que a pessoa escreveu,
// e dado não se traduz.
const TEMPLATE_VARS = [
  { token: "{{nome}}", label: "Nome" },
  { token: "{{telefone}}", label: "Telefone" },
  { token: "{{lead.title}}", label: "Título do lead" },
];

function SendWhatsappForm({
  config,
  onChange,
}: FormProps<{ channel_session_id: string; template: string; media_url?: string | null }>) {
  const t = useT();
  const { data: sessions } = useChannelSessions();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // Uma regra pode ter mais de uma ação de WhatsApp: id fixo repetiria na página.
  const midiaId = React.useId();
  // Os campos cadastrados no funil (Configurações › Funis) viram botões: quem
  // monta a mensagem clica em "Serviço" em vez de adivinhar o nome interno. O
  // token é só a chave — `renderTemplate` a resolve em `lead.custom_fields`.
  const pipeline = useDefaultPipeline(true);
  const camposDoFormulario = camposDoFunil(pipeline.data?.pipeline.settings ?? null)
    .filter((f) => !TEMPLATE_VARS.some((v) => v.token === `{{${f.key}}}`))
    .map((f) => ({ token: `{{${f.key}}}`, label: f.label }));

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
                {channelLabel(s) + (s.status !== "WORKING" ? t(" — desconectado") : "")}
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
          {[...TEMPLATE_VARS.map((v) => ({ ...v, label: t(v.label) })), ...camposDoFormulario].map((v) => (
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
          placeholder={t("Oi {{nome}}, tudo bem?")}
        />
        <p className="text-xs text-muted-foreground">
          {/* NÃO cravar "7h e 22h": a janela passou a vir dos ajustes DO NÚMERO
              (Conexões), no fuso da sua organização, e quem a mudou lá veria a
              tela continuar prometendo outro horário. Rótulo visível é contrato. */}
          {t("Respeitamos a janela de envio e o limite diário configurados para esse número em Conexões — fora da janela, a mensagem espera a próxima.")}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={midiaId}>{t("Imagem, vídeo, áudio ou documento (opcional)")}</Label>
        <Input
          id={midiaId}
          type="url"
          value={config.media_url ?? ""}
          onChange={(e) => onChange({ ...config, media_url: e.target.value || null })}
          placeholder="https://…/oferta.pdf"
        />
        <p className="text-xs text-muted-foreground">
          {t("Com uma imagem, um vídeo, um áudio ou um documento, a mensagem acima vira a legenda do arquivo (o áudio sai como mensagem de voz, sem legenda — o texto não vai junto). Em número oficial, fora da janela de 24h a mídia não sai — só um modelo aprovado.")}
        </p>
      </div>
    </div>
  );
}

/**
 * "Enviar e-mail" (#2726) — quem recebe, o assunto e o corpo.
 *
 * O corpo usa o MESMO jogo de variáveis da irmã de WhatsApp (`TEMPLATE_VARS`
 * + os campos do funil), porque quem montou a regra já escreveu aquela
 * mensagem e não deve recomeçar: `{{destino}}` resolve igual nos dois canais.
 *
 * #2642 (recorte do PR #2834) acrescentou duas coisas, e é aqui que elas
 * aparecem: o destinatário "membro da equipe" (o e-mail que antes morava no
 * `notify_team`) e o botão `{{resumo}}`, que insere o resumo automático do
 * negócio. O endereço da pessoa NÃO se digita: vem do acesso dela, e o vínculo
 * com a empresa é conferido no momento do envio — por isso o aviso embaixo do
 * campo.
 *
 * O que NÃO está aqui de propósito: transporte, credencial e remetente. O
 * envio sai pelo que já foi configurado em Admin › E-mail (SMTP ou Resend) —
 * e o aviso embaixo do corpo diz isso, porque sem ele a pessoa procura uma
 * chave nova que não existe e conclui que a ação não funciona.
 */
function SendEmailForm({
  config,
  onChange,
}: FormProps<{
  destinatario: "contato" | "dono_do_lead" | "membro_da_equipe" | "fixo";
  email_fixo: string;
  membro_id: string;
  assunto: string;
  corpo: string;
  formato: string;
}>) {
  const t = useT();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const { data: membros } = useAssignableMembers(true);
  const pipeline = useDefaultPipeline(true);
  const camposDoFormulario = camposDoFunil(pipeline.data?.pipeline.settings ?? null)
    .filter((f) => !TEMPLATE_VARS.some((v) => v.token === `{{${f.key}}}`))
    .map((f) => ({ token: `{{${f.key}}}`, label: f.label }));

  const insertVar = (token: string) => {
    const el = textareaRef.current;
    const current = config.corpo;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange({ ...config, corpo: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t("Destinatário")}</Label>
          <Select
            value={config.destinatario}
            onValueChange={(v) =>
              onChange({
                ...config,
                destinatario: v as "contato" | "dono_do_lead" | "membro_da_equipe" | "fixo",
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder={t("Escolha quem recebe")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contato">{t("E-mail do contato")}</SelectItem>
              <SelectItem value="dono_do_lead">{t("E-mail do responsável do negócio")}</SelectItem>
              <SelectItem value="membro_da_equipe">{t("E-mail de uma pessoa da equipe")}</SelectItem>
              <SelectItem value="fixo">{t("Endereço fixo")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Assunto")}</Label>
          <Input
            value={config.assunto}
            onChange={(e) => onChange({ ...config, assunto: e.target.value })}
            placeholder={t("Sua viagem para {{destino}}")}
          />
        </div>
      </div>
      {config.destinatario === "fixo" ? (
        <div className="space-y-1">
          <Label>{t("Endereço de e-mail")}</Label>
          <Input
            value={config.email_fixo}
            onChange={(e) => onChange({ ...config, email_fixo: e.target.value })}
            placeholder="nome@empresa.com"
          />
          <p className="text-xs text-muted-foreground">
            {t("Um endereço fixo recebe todos os envios desta regra.")}
          </p>
        </div>
      ) : null}
      {config.destinatario === "membro_da_equipe" ? (
        <div className="space-y-1">
          <Label>{t("Pessoa da equipe")}</Label>
          <Select
            value={config.membro_id}
            onValueChange={(v) => onChange({ ...config, membro_id: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("Escolha quem recebe")} />
            </SelectTrigger>
            <SelectContent>
              {(membros ?? []).map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.user_id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "A pessoa recebe no e-mail cadastrado no acesso dela, e o vínculo com a empresa é conferido no momento do envio.",
            )}
          </p>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label>{t("Corpo do e-mail")}</Label>
        <div className="flex flex-wrap gap-1">
          {[
            ...TEMPLATE_VARS.map((v) => ({ ...v, label: t(v.label) })),
            // #2642 — a variável desta ação: o resumo do negócio montado no
            // disparo (só dado de forma fixa + atalho para a ficha; doc 176 A).
            // Fica só no e-mail de propósito: no WhatsApp da equipe o corpo É
            // o resumo, sem modelo.
            { token: "{{resumo}}", label: t("Resumo do negócio") },
            ...camposDoFormulario,
          ].map((v) => (
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
          rows={5}
          value={config.corpo}
          onChange={(e) => onChange({ ...config, corpo: e.target.value })}
          placeholder={t("Oi {{nome}}, tudo bem?")}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Formato do corpo")}</Label>
        <Select value={config.formato || "texto"} onValueChange={(v) => onChange({ ...config, formato: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="texto">{t("Texto simples")}</SelectItem>
            <SelectItem value="html">{t("HTML simples")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "As variáveis do WhatsApp valem aqui: {{nome}}, {{primeiro_nome}}, {{lead.title}} e os campos do formulário como {{destino}}.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('Para não depender do dado, ponha um texto de reserva: {{primeiro_nome|"aluno"}}.')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "A variável Resumo do negócio leva o nome da regra, o cliente, o telefone, o valor, a pontuação e um atalho para o negócio no CRM (quando a instalação tem endereço público), e nada do que foi conversado com o cliente. O resto do corpo vai como você escrever, inclusive as outras variáveis.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("O envio usa o e-mail configurado em Admin › E-mail (SMTP ou Resend).")}
      </p>
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
                {channelLabel(s) + (s.status !== "WORKING" ? t(" — desconectado") : "")}
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
          placeholder={t(
            "Ex.: Agradeça o interesse citando o segmento que a pessoa informou, mostre em uma frase como a gente resolve a dificuldade que ela descreveu, e pergunte qual o melhor horário para conversar.",
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t("O agente já sabe que é a PRIMEIRA mensagem, logo depois de a pessoa preencher o formulário, e recebe todos os campos que ela respondeu. Aqui você diz o que fazer com eles — quanto mais concreto, melhor a mensagem.")}
        </p>
      </div>
    </div>
  );
}

/**
 * `add_tag` (#2498) — as tags, e AGORA o DESTINO delas.
 *
 * O destino é opcional na forma e no efeito: quem nunca mexeu continua sem
 * chave no config e gravando no card, que é o comportamento de sempre. Só quem
 * escolhe "Contato do lead" passa a gravar na caixa que o Inbox consulta — e
 * a tela diz o que acontece quando o lead não tem contato (a ação é ignorada,
 * nunca troca de destino sozinha).
 */
function AddTagForm({
  config,
  onChange,
}: FormProps<{ tags: string[]; destino?: "card" | "contato" }>) {
  const t = useT();
  const [text, setText] = React.useState(config.tags.join(", "));
  return (
    <div className="space-y-2">
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
            // `...config` preserva o destino escolhido: escrever `{ tags }`
            // aqui apagaria a metade da tela que o operador acabou de preencher.
            onChange({ ...config, tags });
          }}
          placeholder={t("boas-vindas, novo-lead")}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Destino da etiqueta")}</Label>
        <Select
          value={config.destino ?? "card"}
          onValueChange={(v) => onChange({ ...config, destino: v as "card" | "contato" })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="card">{t("Card (comportamento atual)")}</SelectItem>
            <SelectItem value="contato">{t("Contato do lead")}</SelectItem>
          </SelectContent>
        </Select>
        {config.destino === "contato" && (
          <p className="text-xs text-muted-foreground">
            {t("Sem contato vinculado, a etiqueta não é aplicada.")}
          </p>
        )}
      </div>
    </div>
  );
}

function AssignOwnerForm({ config, onChange }: FormProps<ConfigDoAtribuir>) {
  const t = useT();
  const { data: members, isLoading: carregandoMembros } = useAssignableMembers(true);
  // Enquanto a lista de membros não chega, o nome é `null` (a tela mostra um
  // esqueleto): o começo do user_id que aparecia ali não diz nada a ninguém.
  const nomeDe = (userId: string) => {
    if (carregandoMembros) return null;
    const membro = members?.find((m) => m.user_id === userId);
    return membro?.full_name ?? userId.slice(0, 8);
  };

  if (config.modo !== "rodizio") {
    return (
      <div className="space-y-2">
        <ModoDoAtribuir
          modo="fixo"
          onChange={() =>
            onChange({ modo: "rodizio", fila: config.user_id ? [{ user_id: config.user_id, pausado: false }] : [] })
          }
        />
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
      </div>
    );
  }

  const fila = config.fila;
  const mudarFila = (nova: typeof fila) => onChange({ modo: "rodizio", fila: nova });
  const trocar = (de: number, para: number) => {
    const nova = [...fila];
    const [pessoa] = nova.splice(de, 1);
    if (pessoa) nova.splice(para, 0, pessoa);
    mudarFila(nova);
  };
  const foraDaFila = (members ?? []).filter((m) => !fila.some((p) => p.user_id === m.user_id));

  return (
    <div className="space-y-2">
      <ModoDoAtribuir modo="rodizio" onChange={() => onChange({ user_id: fila[0]?.user_id ?? "" })} />
      <div className="space-y-1">
        <Label>{t("Fila do rodízio")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("Cada lead vai para a próxima pessoa da fila, nesta ordem. Quem está pausado é pulado sem sair da fila.")}
        </p>
        {fila.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Ninguém na fila ainda. Adicione pelo menos uma pessoa.")}</p>
        ) : (
          <ol className="space-y-1" data-testid="fila-do-rodizio" aria-busy={carregandoMembros}>
            {fila.map((pessoa, i) => {
              const nomeCarregado = nomeDe(pessoa.user_id);
              const nome = nomeCarregado ?? String(i + 1);
              // Duas partes que QUEBRAM de linha quando a largura não cabe as
              // duas (celular): o nome nunca disputa espaço com os 4 botões de
              // 44px — a 360px ele ficava com 51px, e com 0px quando pausado.
              return (
                <li
                  key={pessoa.user_id}
                  className="flex flex-wrap items-center gap-x-1 gap-y-0.5 rounded-md border px-2 py-1"
                >
                  <div className="flex min-w-0 grow basis-48 items-center gap-1" data-testid="pessoa-da-fila">
                    <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
                    {nomeCarregado === null ? (
                      <Skeleton aria-hidden className="h-4 w-24 max-w-full" />
                    ) : (
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${pessoa.pausado ? "text-muted-foreground line-through" : ""}`}
                      >
                        {nomeCarregado}
                      </span>
                    )}
                    {pessoa.pausado ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{t("pausado")}</span>
                    ) : null}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Subir na fila")}: ${nome}`}
                      disabled={i === 0}
                      onClick={() => trocar(i, i - 1)}
                    >
                      <CaretUp size={16} aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Descer na fila")}: ${nome}`}
                      disabled={i === fila.length - 1}
                      onClick={() => trocar(i, i + 1)}
                    >
                      <CaretDown size={16} aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${pessoa.pausado ? t("Voltar ao rodízio") : t("Pausar no rodízio")}: ${nome}`}
                      onClick={() => mudarFila(fila.map((p, k) => (k === i ? { ...p, pausado: !p.pausado } : p)))}
                    >
                      {pessoa.pausado ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Tirar da fila")}: ${nome}`}
                      onClick={() => mudarFila(fila.filter((_, k) => k !== i))}
                    >
                      <X size={16} aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {foraDaFila.length > 0 ? (
        <div className="space-y-1">
          <Label>{t("Adicionar à fila")}</Label>
          <Select value="" onValueChange={(v) => mudarFila([...fila, { user_id: v, pausado: false }])}>
            <SelectTrigger>
              <SelectValue placeholder={t("Escolha quem entra no rodízio")} />
            </SelectTrigger>
            <SelectContent>
              {foraDaFila.map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.user_id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

/** A escolha entre um atendente fixo e o rodízio. Trocar de modo leva junto quem já estava escolhido. */
function ModoDoAtribuir({ modo, onChange }: { modo: "fixo" | "rodizio"; onChange: () => void }) {
  const t = useT();
  return (
    <div className="space-y-1">
      <Label>{t("Como atribuir")}</Label>
      <Select value={modo} onValueChange={(v) => v !== modo && onChange()}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fixo">{t("Um atendente fixo")}</SelectItem>
          <SelectItem value="rodizio">{t("Em rodízio entre estas pessoas")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * `create_task` (#1540) — o formulário do lembrete que NÃO vira mensagem.
 *
 * Atribuição nominal (`dono_do_lead`) é o padrão e continua sendo a opção que o
 * operador mantém quando o dono do negócio muda; quem quiser fixar uma pessoa
 * escolhe na lista dos atendentes ativos (mesma lista do `assign_owner`).
 */
function CreateTaskForm({
  config,
  onChange,
}: FormProps<{
  titulo: string;
  vence_em_dias: number;
  atribuir_a: "dono_do_lead" | { usuario_id: string };
  prioridade: string;
}>) {
  const t = useT();
  const { data: members } = useAssignableMembers(true);
  const atribuido =
    typeof config.atribuir_a === "object" ? config.atribuir_a.usuario_id : "dono_do_lead";
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <Label>{t("Título da tarefa")}</Label>
        <Input
          value={config.titulo}
          onChange={(e) => onChange({ ...config, titulo: e.target.value })}
          placeholder={t("Ligar para {{contact.name}} sobre {{lead.title}}")}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Vence em (dias)")}</Label>
        <Input
          type="number"
          min={0}
          max={365}
          value={config.vence_em_dias}
          onChange={(e) => onChange({ ...config, vence_em_dias: Number(e.target.value) })}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Prioridade")}</Label>
        <Select value={config.prioridade} onValueChange={(v) => onChange({ ...config, prioridade: v })}>
          <SelectTrigger>
            <SelectValue placeholder={t("Prioridade")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{t("Baixa")}</SelectItem>
            <SelectItem value="medium">{t("Média")}</SelectItem>
            <SelectItem value="high">{t("Alta")}</SelectItem>
            <SelectItem value="urgent">{t("Urgente")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label>{t("Atribuir a")}</Label>
        <Select
          value={atribuido}
          onValueChange={(v) =>
            onChange({ ...config, atribuir_a: v === "dono_do_lead" ? "dono_do_lead" : { usuario_id: v } })
          }
        >
          <SelectTrigger>
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
    </div>
  );
}

function CallWebhookForm({
  config,
  onChange,
}: FormProps<{ url: string; secret?: string; secret_enc?: string; include_owner?: boolean }>) {
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
        <Label>{t("Segredo (opcional)")}</Label>
        <Input
          type="password"
          value={config.secret ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            // Digitou algo novo → substitui; limpou → remove o guardado também.
            const { secret_enc: _enc, ...rest } = config;
            onChange(next ? { ...rest, secret: next } : { ...rest, secret: undefined });
          }}
          placeholder={hasStoredSecret ? t("•••••••• (definido — digite para trocar)") : t("uma senha só sua")}
        />
        <p className="text-xs text-muted-foreground">
          {hasStoredSecret
            ? t("Já existe um segredo guardado com segurança. Digitar aqui substitui; limpar remove.")
            : t("Se preencher, enviaremos uma assinatura para o outro sistema conferir que fomos nós.")}
        </p>
        {/* O guia de quem recebe (#1529). Pelo CAMINHO, em texto, e não link:
            numa instalação de marca própria um link para o repositório de
            origem apareceria para o cliente do revendedor — mesmo precedente
            do UpdatePanel, que aponta o CHANGELOG pelo nome do arquivo. */}
        <p className="text-xs text-muted-foreground">
          {t("Como o outro sistema confere a assinatura e reconhece reenvios: guia de integração em docs/integracao/webhooks-de-saida.md, na documentação do projeto.")}
        </p>
      </div>
      {/* Opt-in do responsável (#1612) — DESLIGADO é o padrão, e a frase diz o
          que muda no corpo: quem lê esta tela é justamente quem vai receber o
          POST. "Incluir" aqui é a mesma palavra do schema (`include_owner`),
          para o rótulo e o campo não parecerem coisas diferentes. */}
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <Label>{t("Incluir o responsável no corpo")}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Padrão: o aviso não diz quem atende. Ligue só se o outro sistema precisar do nome da equipe.",
            )}
          </p>
        </div>
        <Switch
          checked={config.include_owner === true}
          onCheckedChange={(v) => onChange({ ...config, include_owner: v ? true : undefined })}
        />
      </div>
    </div>
  );
}

/**
 * `start_message_flow` (#2647) — o seletor ganhou a SUPERFÍCIE do fluxo.
 *
 * O padrão é follow-up, que é o que toda regra já gravada aponta: mesma lista,
 * mesma rota e MESMO caminho de inscrição de antes. Escolher atendimento troca
 * a lista pela dos roteiros publicados (`?surface=atendimento`) e, na hora de
 * executar, a ação passa por `iniciarFluxoDeAtendimento` — a entrada da
 * palavra-gatilho e do roteador.
 *
 * Trocar de superfície LIMPA o fluxo escolhido: um id de follow-up não é um
 * roteiro, e a regra não pode ficar gravada apontando para o outro lado.
 */
function StartMessageFlowForm({
  config,
  onChange,
}: FormProps<{ flow_pointer_id: string; surface?: "followup" | "atendimento" }>) {
  const t = useT();
  const superficie: "followup" | "atendimento" =
    config.surface === "atendimento" ? "atendimento" : "followup";
  const ehRoteiro = superficie === "atendimento";
  // O módulo é opcional por instalação (mesmo padrão do QueueTab): desligado, a
  // opção some — salvo numa regra que já a grava, para não esconder o que está salvo.
  const { activeOrg } = useAuth();
  const roteirosLigados = activeOrg?.modulos_ligados?.includes("fluxos_atendimento") === true;
  const { data, isLoading } = useQuery({
    // Mesma chave do hook de Follow-ups (com o recorte no fim, como ele faz):
    // a lista de follow-up continua a de sempre, e a dos roteiros fica separada.
    queryKey: ehRoteiro
      ? [...followupFlowsListQueryKey, "atendimento"]
      : followupFlowsListQueryKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: FollowupFlowPointerRow[] }>(
        ehRoteiro
          ? "/api/v1/ai/followup-flows?surface=atendimento"
          : "/api/v1/ai/followup-flows",
      );
      return res.data;
    },
  });
  const active = (data ?? []).filter((f) => f.status === "active");

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t("Tipo de fluxo")}</Label>
        <Select
          value={superficie}
          onValueChange={(v) =>
            onChange({
              flow_pointer_id: "",
              surface: v === "atendimento" ? "atendimento" : "followup",
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="followup">{t("Follow-up")}</SelectItem>
            {roteirosLigados || ehRoteiro ? (
              <SelectItem value="atendimento">{t("Atendimento")}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>{ehRoteiro ? t("Fluxo de atendimento") : t("Fluxo de follow-up")}</Label>
        <Select
          value={config.flow_pointer_id}
          onValueChange={(v) => onChange({ ...config, flow_pointer_id: v })}
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
            {ehRoteiro
              ? t(
                  "Nenhum fluxo de atendimento ativo. Publique um em Fluxos de atendimento para usá-lo aqui.",
                )
              : t("Nenhum fluxo ativo. Publique um follow-up em Follow-ups para usá-lo aqui.")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("Só entram fluxos publicados e ativos.")}
          </p>
        )}
        {/* O roteiro não EMPURRA mensagem ao ser aberto: ele vale no próximo
            turno da conversa. Dizer isso aqui é o que evita quem liga a regra
            e espera sair uma mensagem na hora. */}
        {ehRoteiro ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "O roteiro de atendimento acontece na conversa: a automação abre o atendimento e a primeira pergunta sai quando o cliente responder.",
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * `apply_task_plan` (#1752) — o seletor dos planos CADASTRADOS.
 *
 * A lista vem da MESMA rota que a tela Tarefas › Planos grava
 * (`settings/task-plans`), e é o motor quem a filtra: o que aparece aqui é
 * exatamente o que `lib/tarefas/plano.ts` aplicaria. Um `plano_id` escrito à
 * mão (regra criada pela API) morreria como `plano_nao_encontrado` em cada
 * disparo — o seletor existe para que isso só aconteça se o plano for apagado
 * DEPOIS de a regra estar pronta.
 */
function ApplyTaskPlanForm({ config, onChange }: FormProps<{ plano_id: string }>) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ["settings", "task-plans"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { planos: PlanoDeTarefas[] } }>(
          "/api/v1/settings/task-plans",
        )
      ).data,
  });
  const planos = data?.planos ?? [];

  return (
    <div className="space-y-1">
      <Label>{t("Plano de tarefa")}</Label>
      <Select
        value={config.plano_id}
        onValueChange={(v) => onChange({ plano_id: v })}
        disabled={isLoading}
      >
        <SelectTrigger>
          <SelectValue placeholder={t("Escolha um plano cadastrado")} />
        </SelectTrigger>
        <SelectContent>
          {planos.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.nome}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Carregando não diz nada: a frase abaixo só é verdade quando a lista
          JÁ chegou, e um aviso de "nenhum plano" durante o carregamento ensina
          o operador a desistir antes de a resposta chegar. */}
      {isLoading ? null : planos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Nenhum plano cadastrado ainda. Cadastre em Tarefas › Planos.")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            "Cada aplicação cria as tarefas do plano na ordem e não duplica — a marca da aplicação é a prova.",
          )}
        </p>
      )}
    </div>
  );
}

/**
 * `notify_team` (#2642) — o formulário do aviso que NUNCA vai para o lead.
 *
 * Depois do recorte do PR #2834 não há escolha nenhuma aqui: o resumo vai para
 * o WhatsApp que o ADMIN cadastrou em Avisos, e o corpo é montado no disparo
 * só com dado de forma fixa e o atalho para a ficha. O formulário NÃO
 * oferece destino colado, pessoa nem texto — um campo de texto seria um
 * template, que é exatamente o defeito do aviso de caso que esta ação fecha, e
 * "quem recebe" virou pergunta sem resposta útil (o destino é o da empresa).
 *
 * O e-mail para uma pessoa da equipe mora no `send_email`, no destinatário
 * "E-mail de uma pessoa da equipe".
 */
function NotifyTeamForm() {
  const t = useT();
  return (
    <div className="space-y-1">
      <Label>{t("WhatsApp da equipe")}</Label>
      <p className="text-xs text-muted-foreground">
        {t("Vai para o WhatsApp cadastrado em Avisos.")}{" "}
        {t(
          "O resumo leva o nome da regra, o cliente, o telefone, o valor, a pontuação e um atalho para o negócio no CRM (quando a instalação tem endereço público). O que foi conversado com o cliente não vai na mensagem.",
        )}
      </p>
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
    case "send_email":
      return (
        <SendEmailForm
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
    case "create_task":
      return (
        <CreateTaskForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "apply_task_plan":
      return (
        <ApplyTaskPlanForm
          config={action.config}
          onChange={(config) => onChange({ type: action.type, config })}
        />
      );
    case "notify_team":
      return <NotifyTeamForm />;
  }
}
