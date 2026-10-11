"use client";

import { useQuery } from "@tanstack/react-query";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { apiClient } from "@/lib/api/client";
import { GATILHO_DE_DATA_DO_FUNIL } from "@/lib/automation/gatilho-de-data-do-funil";
import { GATILHO_ETAPA_PARADA, GATILHO_SILENCIO } from "@/lib/automation/gatilhos-de-tempo";
import type { DadosDaCaixa, ExtrasDaTela, TipoDeCaixa } from "@/lib/automation/desenho-da-regra";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { usePipelineStages, usePipelines, useWebhookSources } from "@/hooks/webhooks/useWebhookSources";
import type { PlanoDeTarefas } from "@/lib/tarefas/plano";
import { CURATED_FIELDS, OP_LABELS, type Op } from "@/app/app/webhooks/_components/RuleEditor";
import { ACTION_LABELS, TRIGGER_LABELS, type ActionType, type TriggerEvent } from "@/app/app/webhooks/_components/labels";

import { VISUAL_DAS_CONDICOES, VISUAL_DO_GATILHO, visualDaAcao } from "./visual";

/**
 * O que o canvas põe em cada caixa: os dados da regra mais o que é só de tela —
 * `etapa` ("Quando", "Se", "Então · Ação 2") e `eventoDaRegra`, que a caixa de
 * condições precisa para nomear o campo.
 */
export type DadosNaTela = DadosDaCaixa & ExtrasDaTela;
export type NoDaAutomacao = Node<DadosNaTela, TipoDeCaixa>;

const cfg = (c: Record<string, unknown>, k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");

/* ───────────── descrições que dependem de nomes cadastrados ───────────── */

function DescricaoDoMover({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const { data: funis } = usePipelines();
  const { data: quadro } = usePipelineStages(cfg(config, "pipeline_id") || null);
  const funil = funis?.data?.find((p) => p.id === config.pipeline_id);
  const etapa = quadro?.data?.stages.find((s) => s.id === config.stage_id);
  if (!funil || !etapa) return <>{t("Escolha o funil e a etapa")}</>;
  return <>{`${funil.name} › ${etapa.name}`}</>;
}

function DescricaoDoAtendente({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const { data: membros } = useAssignableMembers(true);
  const membro = membros?.find((m) => m.user_id === config.user_id);
  return <>{membro ? (membro.full_name ?? membro.user_id.slice(0, 8)) : t("Escolha o atendente")}</>;
}

function DescricaoDaMensagemPelaIa({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const { data: agentes } = useAgentsList();
  const agente = agentes?.find((a) => a.id === config.agent_id);
  const instrucao = cfg(config, "instruction").trim();
  return <>{`${agente ? agente.name : t("Escolha o agente")}${instrucao ? ` · ${instrucao}` : ""}`}</>;
}

/** Mesma chave e mesma busca do seletor de fluxo do editor: o cache é um só. */
function DescricaoDoFluxo({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["followup", "flows", "list"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: FollowupFlowPointerRow[] }>("/api/v1/ai/followup-flows");
      return res.data;
    },
  });
  const fluxo = (data ?? []).find((f) => f.id === config.flow_pointer_id);
  return <>{fluxo ? fluxo.name : t("Escolha o fluxo de follow-up")}</>;
}

/** Mesma chave e mesma busca do seletor de plano do editor. */
function DescricaoDoPlano({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["settings", "task-plans"],
    queryFn: async () =>
      (await apiClient.get<{ data: { planos: PlanoDeTarefas[] } }>("/api/v1/settings/task-plans")).data,
  });
  const plano = data?.planos.find((p) => p.id === config.plano_id);
  return <>{plano ? plano.nome : t("Escolha o plano de tarefas")}</>;
}

function DescricaoDaAcao({ tipo, config }: { tipo: string; config: Record<string, unknown> }) {
  const t = useT();
  switch (tipo as ActionType) {
    case "create_or_move_lead":
      return <DescricaoDoMover config={config} />;
    case "assign_owner":
      return <DescricaoDoAtendente config={config} />;
    case "send_ai_message":
      return <DescricaoDaMensagemPelaIa config={config} />;
    case "start_message_flow":
      return <DescricaoDoFluxo config={config} />;
    case "apply_task_plan":
      return <DescricaoDoPlano config={config} />;
    case "send_whatsapp_message": {
      const texto = cfg(config, "template").trim();
      return <>{texto ? `“${texto}”` : t("Escreva a mensagem")}</>;
    }
    case "add_tag": {
      const tags = Array.isArray(config.tags) ? (config.tags as unknown[]).map(String) : [];
      return <>{tags.length ? tags.join(", ") : t("Escreva pelo menos uma tag")}</>;
    }
    case "call_webhook":
      return <>{cfg(config, "url").trim() || t("Informe o endereço")}</>;
    case "create_task": {
      const titulo = cfg(config, "titulo").trim() || t("Sem título");
      const dias = typeof config.vence_em_dias === "number" ? config.vence_em_dias : 0;
      return <>{`${titulo} · ${dias ? `${t("vence em")} ${dias} ${dias === 1 ? t("dia") : t("dias")}` : t("vence hoje")}`}</>;
    }
  }
  return <>{tipo}</>;
}

function DescricaoDoGatilho({ dados }: { dados: Extract<DadosDaCaixa, { kind: "gatilho" }> }) {
  const t = useT();
  const { data: fontes } = useWebhookSources();
  const { data: funis } = usePipelines();
  const evento = dados.evento as TriggerEvent | "";
  if (!evento) return <>{t("Escolha o que dispara a automação")}</>;
  const rotulo = t(TRIGGER_LABELS[evento] ?? evento);
  let detalhe = "";
  if (evento === "lead.created") {
    const fonte = fontes?.data?.find((f) => f.id === dados.tela.fonte);
    detalhe = dados.tela.fonte ? (fonte ? fonte.name : t("Fonte removida")) : t("Qualquer fonte");
  } else if (evento === GATILHO_DE_DATA_DO_FUNIL) {
    const funil = funis?.data?.find((p) => p.id === dados.tela.data.pipeline_id);
    const campo = funil ? camposDoFunil(funil.settings ?? null).find((c) => c.key === dados.tela.data.campo) : undefined;
    detalhe = campo ? `${campo.label} · N = ${dados.tela.data.dias}` : t("Escolha o funil e o campo de data");
  } else if (evento === GATILHO_SILENCIO || evento === GATILHO_ETAPA_PARADA) {
    detalhe = `N = ${dados.tela.tempo.dias}`;
  }
  return <>{detalhe ? `${rotulo} · ${detalhe}` : rotulo}</>;
}

function DescricaoDasCondicoes({ dados, evento }: { dados: Extract<DadosDaCaixa, { kind: "condicoes" }>; evento: string }) {
  const t = useT();
  const { data: funis } = usePipelines();
  const padrao = funis?.data?.find((p) => p.is_default) ?? funis?.data?.[0] ?? null;
  const { data: quadro } = usePipelineStages(padrao?.id ?? null);
  const completas = dados.linhas.filter((l) => l.field.trim() && l.value.trim());
  if (completas.length === 0) return <>{t("Nenhuma condição completa: roda em todo evento")}</>;
  const campos = CURATED_FIELDS[evento as TriggerEvent] ?? [];
  const primeira = completas[0]!;
  const campo = campos.find((c) => c.value === primeira.field);
  const op = t(campo?.lista && primeira.op === "contains" ? "tem a tag" : OP_LABELS[primeira.op as Op]);
  const valor =
    campo?.kind === "stage" ? (quadro?.data?.stages.find((s) => s.id === primeira.value)?.name ?? primeira.value) : primeira.value;
  const frase = `${campo ? t(campo.label) : primeira.field} ${op} “${valor}”`;
  return <>{completas.length > 1 ? `${frase} (+${completas.length - 1})` : frase}</>;
}

/* ───────────── a caixa ───────────── */

/**
 * O cartão de uma caixa do designer: o MESMO desenho do cartão do construtor de
 * follow-up (`NodeCard`), com a etapa da fila em cima do título. Entrada em
 * cima, saída embaixo — numa automação a ordem é a fila, então cada caixa tem
 * uma de cada (o gatilho só tem saída).
 */
export function CaixaDaAutomacao({ id, data, selected }: NodeProps<NoDaAutomacao>) {
  const t = useT();
  const problemas = data.problemas ?? [];
  const temProblema = problemas.length > 0;
  const visual =
    data.kind === "gatilho" ? VISUAL_DO_GATILHO : data.kind === "condicoes" ? VISUAL_DAS_CONDICOES : visualDaAcao(data.acao.type);
  const Icone = visual.icon;
  const titulo =
    data.kind === "gatilho"
      ? t("Gatilho")
      : data.kind === "condicoes"
        ? t("Condições")
        : data.acao.type === "ai_decide"
          ? t("A IA decide")
          : t(ACTION_LABELS[data.acao.type as ActionType] ?? data.acao.type);
  const opcoes =
    data.kind === "acao" && data.acao.type === "ai_decide" && Array.isArray(data.acao.config.opcoes)
      ? (data.acao.config.opcoes as Array<{ rotulo?: unknown; acao?: { type?: unknown } | null }>)
      : null;

  return (
    <div
      className={cn(
        "w-56 rounded-md border border-l-4 border-border bg-surface shadow-sm transition-shadow",
        visual.borderClassName,
        selected && "ring-2 ring-accent-500 ring-offset-1 ring-offset-bg",
        temProblema && "border-error ring-2 ring-error ring-offset-1 ring-offset-bg",
      )}
      data-testid={`caixa-${id}`}
      title={temProblema ? problemas.map((p) => t(p.mensagem)).join("; ") : undefined}
    >
      {data.kind !== "gatilho" && <Handle type="target" position={Position.Top} />}
      <div className="flex items-start gap-2 px-3 py-2">
        <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", visual.chipClassName)}>
          <Icone size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {data.etapa ? (
            <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{data.etapa}</p>
          ) : null}
          <p className="line-clamp-2 break-words text-sm font-medium text-text">{titulo}</p>
          <p className="line-clamp-2 break-words text-xs text-text-muted">
            {data.kind === "gatilho" ? (
              <DescricaoDoGatilho dados={data} />
            ) : data.kind === "condicoes" ? (
              <DescricaoDasCondicoes dados={data} evento={data.eventoDaRegra ?? ""} />
            ) : data.acao.type === "ai_decide" ? (
              t("Hoje este passo só se edita pela API")
            ) : (
              <DescricaoDaAcao tipo={data.acao.type} config={data.acao.config} />
            )}
          </p>
        </div>
      </div>
      {data.kind === "condicoes" && (
        <p className="border-t border-border/60 px-3 py-1.5 text-xs italic text-text-muted">
          {t("Se não atender, nada acontece.")}
        </p>
      )}
      {opcoes && (
        <ul className="border-t border-border/60 px-3 py-1.5" data-testid={`caixa-${id}-opcoes`}>
          {opcoes.map((o, i) => (
            <li key={i} className="line-clamp-2 break-words text-xs text-text-muted">
              {`${typeof o.rotulo === "string" ? o.rotulo : "—"} → ${
                typeof o.acao?.type === "string" ? t(ACTION_LABELS[o.acao.type as ActionType] ?? o.acao.type) : "—"
              }`}
            </li>
          ))}
        </ul>
      )}
      {temProblema && (
        <p className="border-t border-error/30 px-3 py-1.5 text-xs leading-snug text-error-fg" data-testid={`caixa-${id}-problema`}>
          {t(problemas[0]!.mensagem)}
          {problemas.length > 1 ? ` (+${problemas.length - 1})` : ""}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
