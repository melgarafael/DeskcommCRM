"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  Copy,
  Funnel,
  PencilSimple,
  Play,
  Plus,
  ShieldCheck,
  Sparkle,
  Trash,
  Warning,
  X,
} from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Criteria = {
  speed?: boolean;
  politeness?: boolean;
  objection_handling?: boolean;
  closing?: boolean;
  opening_message?: string;
};

type Execution = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  score: number | null;
  first_response_time_seconds: number | null;
  messages_exchanged: number;
  ai_feedback: string | null;
  started_at: string;
  completed_at: string | null;
};

type Scenario = {
  id: string;
  title: string;
  persona_name: string;
  persona_description: string;
  objective: string;
  target_channel_session_id: string | null;
  target_phone: string | null;
  evaluation_criteria: Criteria;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  audit_mystery_executions?: Execution[];
};

type Channel = {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string;
};

type FormState = {
  title: string;
  persona_name: string;
  persona_description: string;
  objective: string;
  target_channel_session_id: string;
  target_phone: string;
  opening_message: string;
  speed: boolean;
  politeness: boolean;
  objection_handling: boolean;
  closing: boolean;
  is_active: boolean;
};

const EMPTY_FORM: FormState = {
  title: "",
  persona_name: "Ricardo, lead criterioso",
  persona_description: "Empresário objetivo, compara alternativas e pede clareza antes de decidir.",
  objective:
    "Avaliar tempo de resposta, descoberta da necessidade, condução da objeção e fechamento.",
  target_channel_session_id: "",
  target_phone: "",
  opening_message:
    "Olá! Vi o trabalho de vocês e queria entender melhor como funciona. Pode me ajudar?",
  speed: true,
  politeness: true,
  objection_handling: true,
  closing: true,
  is_active: true,
};

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message ?? payload.error ?? "Não foi possível concluir a ação.");
  }
  return payload;
}

function formFromScenario(scenario: Scenario): FormState {
  return {
    title: scenario.title,
    persona_name: scenario.persona_name,
    persona_description: scenario.persona_description,
    objective: scenario.objective,
    target_channel_session_id: scenario.target_channel_session_id ?? "",
    target_phone: scenario.target_phone ?? "",
    opening_message: scenario.evaluation_criteria?.opening_message ?? "",
    speed: scenario.evaluation_criteria?.speed !== false,
    politeness: scenario.evaluation_criteria?.politeness !== false,
    objection_handling: scenario.evaluation_criteria?.objection_handling !== false,
    closing: scenario.evaluation_criteria?.closing !== false,
    is_active: scenario.is_active,
  };
}

function statusLabel(status: Execution["status"]) {
  if (status === "completed") return "Concluída";
  if (status === "failed") return "Falhou";
  if (status === "running") return "Em andamento";
  return "Preparando";
}

export function MysteryShopperClient({ orgId: _orgId }: { orgId: string }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
    conversationId?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scenarioResponse, channelResponse] = await Promise.all([
        fetch("/api/v1/audit/mystery", { cache: "no-store" }),
        fetch("/api/v1/channel-sessions", { cache: "no-store" }),
      ]);
      const scenarioPayload = await readJson(scenarioResponse);
      const channelPayload = await readJson(channelResponse);
      setScenarios(scenarioPayload.scenarios ?? []);
      setChannels(
        (channelPayload.data ?? []).filter((channel: Channel) => channel.status === "WORKING"),
      );
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Falha ao carregar.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const executions = useMemo(
    () => scenarios.flatMap((scenario) => scenario.audit_mystery_executions ?? []),
    [scenarios],
  );
  const completed = executions.filter((execution) => execution.status === "completed");
  const scored = completed.filter((execution) => execution.score != null);
  const averageScore = scored.length
    ? scored.reduce((total, execution) => total + Number(execution.score), 0) / scored.length
    : null;
  const timed = completed.filter((execution) => execution.first_response_time_seconds != null);
  const averageResponse = timed.length
    ? Math.round(
        timed.reduce(
          (total, execution) => total + Number(execution.first_response_time_seconds),
          0,
        ) / timed.length,
      )
    : null;

  const filtered = scenarios.filter((scenario) => {
    const haystack =
      `${scenario.title} ${scenario.persona_name} ${scenario.objective}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (!onlyActive || scenario.is_active);
  });

  function openCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, target_channel_session_id: channels[0]?.id ?? "" });
    setModalOpen(true);
  }

  function openEdit(scenario: Scenario) {
    setEditingId(scenario.id);
    setForm(formFromScenario(scenario));
    setModalOpen(true);
  }

  function payloadFromForm(current: FormState) {
    return {
      title: current.title.trim(),
      persona_name: current.persona_name.trim(),
      persona_description: current.persona_description.trim(),
      objective: current.objective.trim(),
      target_channel_session_id: current.target_channel_session_id || null,
      target_phone: current.target_phone.trim() || null,
      evaluation_criteria: {
        speed: current.speed,
        politeness: current.politeness,
        objection_handling: current.objection_handling,
        closing: current.closing,
        opening_message: current.opening_message.trim(),
      },
      is_active: current.is_active,
    };
  }

  async function saveScenario(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      await readJson(
        await fetch(editingId ? `/api/v1/audit/mystery/${editingId}` : "/api/v1/audit/mystery", {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadFromForm(form)),
        }),
      );
      setModalOpen(false);
      setNotice({
        kind: "success",
        text: editingId ? "Cenário atualizado." : "Cenário criado e pronto para uso.",
      });
      await load();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível salvar.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleScenario(scenario: Scenario) {
    try {
      await readJson(
        await fetch(`/api/v1/audit/mystery/${scenario.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !scenario.is_active }),
        }),
      );
      await load();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível alterar o status.",
      });
    }
  }

  async function duplicateScenario(scenario: Scenario) {
    const copy = formFromScenario(scenario);
    try {
      await readJson(
        await fetch("/api/v1/audit/mystery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payloadFromForm(copy), title: `${copy.title} (cópia)` }),
        }),
      );
      setNotice({ kind: "success", text: "Cenário duplicado." });
      await load();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível duplicar.",
      });
    }
  }

  async function deleteScenario(scenario: Scenario) {
    if (!window.confirm(`Excluir “${scenario.title}” e todo o histórico de auditorias?`)) return;
    try {
      await readJson(await fetch(`/api/v1/audit/mystery/${scenario.id}`, { method: "DELETE" }));
      setNotice({ kind: "success", text: "Cenário excluído." });
      await load();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível excluir.",
      });
    }
  }

  async function runScenario(scenario: Scenario) {
    setRunningId(scenario.id);
    setNotice(null);
    try {
      const payload = await readJson(
        await fetch(`/api/v1/audit/mystery/${scenario.id}/execute`, { method: "POST" }),
      );
      setNotice({
        kind: "success",
        text: "Auditoria iniciada. A primeira mensagem foi enviada pelo canal escolhido.",
        conversationId: payload.conversation_id,
      });
      await load();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível iniciar.",
      });
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-5 border-b border-border/70 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-[11px] font-semibold tracking-[0.16em] text-accent uppercase">
            <ShieldCheck size={14} /> Qualidade de atendimento
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Cliente Oculto</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Crie a persona, escolha o número que será auditado, dispare o teste e acompanhe cada
              execução.
            </p>
          </div>
        </div>
        <Button onClick={openCreate} className="rounded-full px-5">
          <Plus size={17} weight="bold" /> Novo cenário
        </Button>
      </header>

      {notice && (
        <div
          className={cn(
            "flex items-start justify-between gap-4 rounded-xl px-4 py-3 text-sm ring-1",
            notice.kind === "success"
              ? "bg-success/10 text-success ring-success/20"
              : "bg-error/10 text-error ring-error/20",
          )}
        >
          <div className="flex items-start gap-2">
            {notice.kind === "success" ? <CheckCircle size={18} /> : <Warning size={18} />}
            <span>
              {notice.text}
              {notice.conversationId && (
                <a
                  className="ml-2 font-semibold underline"
                  href={`/app/inbox/${notice.conversationId}`}
                >
                  Abrir conversa
                </a>
              )}
            </span>
          </div>
          <button aria-label="Fechar aviso" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        {[
          [
            "Cenários ativos",
            String(scenarios.filter((scenario) => scenario.is_active).length),
            "Prontos para executar",
          ],
          [
            "Execuções",
            String(executions.length),
            `${executions.filter((execution) => execution.status === "running").length} em andamento`,
          ],
          [
            "Nota média",
            averageScore == null ? "Sem nota" : averageScore.toFixed(1),
            averageScore == null ? "Execute e avalie o primeiro teste" : "de 10 pontos",
          ],
          [
            "Primeira resposta",
            averageResponse == null ? "Sem dados" : `${averageResponse}s`,
            "média das concluídas",
          ],
        ].map(([label, value, detail]) => (
          <div key={label} className="rounded-2xl bg-surface p-1 ring-1 ring-border/60">
            <div className="rounded-[0.85rem] bg-card px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
              <p className="mt-1 text-xs text-text-subtle">{detail}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Cenários de auditoria</h2>
            <p className="text-sm text-muted-foreground">
              Toda configuração e o histórico operacional em um só lugar.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative">
              <Funnel
                className="absolute top-1/2 left-3 -translate-y-1/2 text-text-subtle"
                size={15}
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar cenário"
                className="pl-9 sm:w-64"
              />
            </div>
            <label className="flex items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground">
              <Switch checked={onlyActive} onCheckedChange={setOnlyActive} /> Só ativos
            </label>
          </div>
        </div>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl bg-card ring-1 ring-border/60">
            <CircleNotch className="animate-spin text-accent" size={28} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl bg-card px-6 text-center ring-1 ring-border/60">
            <div className="mb-4 rounded-2xl bg-accent-soft p-4 text-accent">
              <ShieldCheck size={30} />
            </div>
            <h3 className="text-lg font-semibold">Nenhum cenário configurado</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Defina quem o cliente simulado será, qual número receberá a abordagem e o que deve ser
              avaliado.
            </p>
            <Button onClick={openCreate} className="mt-5 rounded-full">
              <Plus size={16} /> Criar primeiro cenário
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {filtered.map((scenario) => {
              const history = [...(scenario.audit_mystery_executions ?? [])].sort((a, b) =>
                b.started_at.localeCompare(a.started_at),
              );
              const latest = history[0];
              const ready = Boolean(
                scenario.target_channel_session_id &&
                scenario.target_phone &&
                scenario.evaluation_criteria?.opening_message,
              );
              return (
                <article
                  key={scenario.id}
                  className="rounded-2xl bg-surface p-1 ring-1 ring-border/60"
                >
                  <div className="h-full rounded-[0.85rem] bg-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                              scenario.is_active
                                ? "bg-success/10 text-success"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {scenario.is_active ? "Ativo" : "Pausado"}
                          </span>
                          {latest && (
                            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-accent">
                              Última: {statusLabel(latest.status)}
                            </span>
                          )}
                        </div>
                        <h3 className="mt-3 truncate text-lg font-semibold">{scenario.title}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Persona: {scenario.persona_name}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Editar"
                          onClick={() => openEdit(scenario)}
                        >
                          <PencilSimple />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Duplicar"
                          onClick={() => void duplicateScenario(scenario)}
                        >
                          <Copy />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Excluir"
                          onClick={() => void deleteScenario(scenario)}
                        >
                          <Trash />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl bg-muted/50 p-3">
                        <p className="text-[11px] font-semibold tracking-wider text-text-subtle uppercase">
                          Destino
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {scenario.target_phone || "Não informado"}
                        </p>
                      </div>
                      <div className="rounded-xl bg-muted/50 p-3">
                        <p className="text-[11px] font-semibold tracking-wider text-text-subtle uppercase">
                          Histórico
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {history.length} {history.length === 1 ? "execução" : "execuções"}
                        </p>
                      </div>
                    </div>
                    <p className="mt-4 line-clamp-2 text-sm text-muted-foreground">
                      {scenario.objective}
                    </p>
                    {latest && (
                      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border/60 pt-4 text-xs text-muted-foreground">
                        <span>{new Date(latest.started_at).toLocaleString("pt-BR")}</span>
                        {latest.score != null && (
                          <span className="flex items-center gap-1 font-semibold text-foreground">
                            <Sparkle size={14} weight="fill" className="text-warning" />{" "}
                            {Number(latest.score).toFixed(1)}
                          </span>
                        )}
                        {latest.ai_feedback && (
                          <span className="line-clamp-1 flex-1">{latest.ai_feedback}</span>
                        )}
                      </div>
                    )}
                    <div className="mt-5 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                      <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <Switch
                          checked={scenario.is_active}
                          onCheckedChange={() => void toggleScenario(scenario)}
                        />
                        {scenario.is_active ? "Cenário ativo" : "Cenário pausado"}
                      </label>
                      <Button
                        disabled={!scenario.is_active || !ready || runningId === scenario.id}
                        onClick={() => void runScenario(scenario)}
                        className="rounded-full px-5"
                      >
                        {runningId === scenario.id ? (
                          <CircleNotch className="animate-spin" />
                        ) : (
                          <Play weight="fill" />
                        )}
                        {ready ? "Auditar agora" : "Complete a configuração"}
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[94dvh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-surface p-1.5 shadow-2xl ring-1 ring-white/10">
            <div className="rounded-[0.85rem] bg-card">
              <div className="flex items-start justify-between border-b border-border/60 px-5 py-5 md:px-7">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.16em] text-accent uppercase">
                    Configuração operacional
                  </p>
                  <h2 className="mt-1 text-xl font-semibold">
                    {editingId ? "Editar cenário" : "Novo cenário de cliente oculto"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Esses dados controlam quem fala, por onde sai e o que será medido.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setModalOpen(false)}
                  aria-label="Fechar"
                >
                  <X />
                </Button>
              </div>
              <form onSubmit={saveScenario} className="space-y-7 px-5 py-6 md:px-7">
                <fieldset className="grid gap-4 md:grid-cols-2">
                  <legend className="mb-4 text-sm font-semibold">1. Cenário e persona</legend>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="title">Nome do cenário</Label>
                    <Input
                      id="title"
                      required
                      value={form.title}
                      onChange={(event) => setForm({ ...form, title: event.target.value })}
                      placeholder="Objeção de preço no WhatsApp"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona">Nome da persona</Label>
                    <Input
                      id="persona"
                      required
                      value={form.persona_name}
                      onChange={(event) => setForm({ ...form, persona_name: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Número que será auditado</Label>
                    <Input
                      id="phone"
                      required
                      value={form.target_phone}
                      onChange={(event) => setForm({ ...form, target_phone: event.target.value })}
                      placeholder="5511999999999"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="persona-description">Comportamento da persona</Label>
                    <Textarea
                      id="persona-description"
                      required
                      rows={3}
                      value={form.persona_description}
                      onChange={(event) =>
                        setForm({ ...form, persona_description: event.target.value })
                      }
                    />
                  </div>
                </fieldset>
                <fieldset className="grid gap-4 md:grid-cols-2">
                  <legend className="mb-4 text-sm font-semibold">2. Canal e abordagem</legend>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="channel">Canal de saída</Label>
                    <select
                      id="channel"
                      required
                      value={form.target_channel_session_id}
                      onChange={(event) =>
                        setForm({ ...form, target_channel_session_id: event.target.value })
                      }
                      className="flex h-11 w-full rounded-md border border-border bg-background px-3 text-sm lg:h-9"
                    >
                      <option value="">Selecione um número conectado</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.display_name || channel.phone_number || "WhatsApp"}
                        </option>
                      ))}
                    </select>
                    {channels.length === 0 && (
                      <p className="text-xs text-error">
                        Nenhum canal WhatsApp conectado e operacional.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="opening">Primeira mensagem enviada ao atendimento</Label>
                    <Textarea
                      id="opening"
                      required
                      rows={3}
                      value={form.opening_message}
                      onChange={(event) =>
                        setForm({ ...form, opening_message: event.target.value })
                      }
                      placeholder="Olá! Gostaria de entender melhor..."
                    />
                    <p className="text-xs text-text-subtle">
                      A mensagem sai de verdade ao clicar em Auditar agora.
                    </p>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="objective">Objetivo interno da avaliação</Label>
                    <Textarea
                      id="objective"
                      required
                      rows={3}
                      value={form.objective}
                      onChange={(event) => setForm({ ...form, objective: event.target.value })}
                    />
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-4 text-sm font-semibold">3. Critérios avaliados</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {([
                      ["speed", "Velocidade", "Tempo até a primeira resposta"],
                      ["politeness", "Cordialidade", "Clareza, educação e empatia"],
                      [
                        "objection_handling",
                        "Objeções",
                        "Como dúvidas e resistência são conduzidas",
                      ],
                      ["closing", "Fechamento", "Próximo passo e chamada para ação"],
                    ] as const).map(([key, label, help]) => (
                      <label
                        key={key}
                        className="flex items-start gap-3 rounded-xl bg-muted/45 p-3"
                      >
                        <Switch
                          checked={Boolean(form[key as keyof FormState])}
                          onCheckedChange={(checked) => setForm({ ...form, [key]: checked })}
                        />
                        <span>
                          <span className="block text-sm font-medium">{label}</span>
                          <span className="text-xs text-muted-foreground">{help}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={form.is_active}
                      onCheckedChange={(checked) => setForm({ ...form, is_active: checked })}
                    />{" "}
                    Deixar ativo ao salvar
                  </label>
                  <div className="flex gap-2">
                    <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={saving}>
                      {saving && <CircleNotch className="animate-spin" />}
                      {editingId ? "Salvar alterações" : "Criar cenário"}
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
