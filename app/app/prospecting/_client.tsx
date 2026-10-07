"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { randomId } from "@/lib/random-id";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import {
  RAZAO_NAO_SELECIONADA,
  safePublicLink,
  type CampaignConfig,
  type Prospect,
} from "@/lib/prospecting/schema";
import { ProspectingAgentBuilder, type CreatedProspectingAgent } from "./_create-agent";
import type { ProspectingAgentSetupInput } from "@/lib/prospecting/agent-setup-schema";

type Campaign = {
  id: string;
  name: string;
  status: string;
  search_status: string;
  error: string | null;
  config: CampaignConfig | null;
  result_count: number;
  skipped_count: number;
  cost_usd: string | null;
  next_send_at: string;
};
type Candidate = {
  id: string;
  campaign_id: string;
  data: Prospect;
  selected?: boolean;
  status?: string;
  lead_id?: string | null;
  progress: string;
  message_status: string | null;
  error: string | null;
  conversation_id: string | null;
};
type State = {
  configured: boolean;
  campaigns: Campaign[];
  candidates: Candidate[];
  agents: { id: string; name: string }[];
  channels: {
    id: string;
    display_name: string | null;
    phone_number: string | null;
    status: string;
  }[];
  stages: { id: string; name: string; pipeline_id: string; pipeline_name: string }[];
};
const labels: Record<string, string> = {
  draft: "Preparar campanha",
  running: "Em andamento",
  paused: "Pausada",
  completed: "Abordagens concluídas",
  starting: "Iniciando busca",
  succeeded: "Busca concluída",
  failed: "Revisar falha",
  unknown: "Busca sem confirmação",
  new: "Encontrado",
  queued: "Na fila",
  sending: "Preparando abordagem",
  sent: "Abordado",
  skipped: "Não abordado",
  replied: "Respondeu",
  qualified: "Qualificado",
};
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const emptyConfig: CampaignConfig = {
  agent_id: "",
  channel_session_id: "",
  pipeline_id: "",
  stage_id: "",
  qualified_stage_id: "",
  instruction: "",
  qualification: "",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "",
  // Campanha nova nasce no modo recomendado; a configuração já gravada manda no que existe.
  funnel_entry: "on_send",
};
export function ProspectingClient() {
  const t = useT();
  const query = useQuery({
    queryKey: ["prospecting"],
    queryFn: async () => (await apiClient.get<{ data: State }>("/api/v1/prospecting")).data,
    refetchInterval: 10000,
  });
  const data = query.data;
  const searchAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [niche, setNiche] = useState("");
  const [location, setLocation] = useState("");
  const [limit, setLimit] = useState(20);
  const [budget, setBudget] = useState(1);
  const [enrich, setEnrich] = useState(true);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<string, CampaignConfig>>({});
  const [manualCampaigns, setManualCampaigns] = useState<Record<string, boolean>>({});
  const [createdAgents, setCreatedAgents] = useState<{ id: string; name: string }[]>([]);
  // As desmarcadas ficam escondidas por padrão; este botão só decide se aparecem.
  const [mostrarDesmarcadas, setMostrarDesmarcadas] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  // Edição do ritmo de uma campanha PAUSADA; vale para uma campanha por vez.
  const [ritmo, setRitmo] = useState<{
    campaignId: string;
    daily_limit: number;
    interval_minutes: number;
  } | null>(null);
  const campaign = data?.campaigns.find((c) => c.id === selected) ?? data?.campaigns[0];
  // A stored config is frozen by activation; unsaved choices belong to one campaign.
  const config = campaign?.config ?? (campaign && campaignDrafts[campaign.id]) ?? emptyConfig;
  const funil = config.pipeline_id;
  const manual = !!campaign && (manualCampaigns[campaign.id] || !!campaign.config);
  const agents = [
    ...new Map(
      [...(data?.agents ?? []), ...createdAgents].map((agent) => [agent.id, agent]),
    ).values(),
  ];
  function setConfig(update: CampaignConfig | ((previous: CampaignConfig) => CampaignConfig)) {
    if (!campaign || campaign.config) return;
    setCampaignDrafts((drafts) => ({
      ...drafts,
      [campaign.id]:
        typeof update === "function" ? update(drafts[campaign.id] ?? emptyConfig) : update,
    }));
  }
  async function selectCreatedAgent(
    campaignId: string,
    result: CreatedProspectingAgent,
    setup: Omit<
      ProspectingAgentSetupInput,
      "request_id" | "campaign_id" | "enable_router_continuity"
    >,
  ) {
    setCreatedAgents((current) => [
      ...current.filter((agent) => agent.id !== result.agent.id),
      result.agent,
    ]);
    setCampaignDrafts((drafts) => ({
      ...drafts,
      [campaignId]: {
        ...(drafts[campaignId] ?? emptyConfig),
        agent_id: result.agent.id,
        channel_session_id: setup.channel_session_id,
        pipeline_id: setup.pipeline_id,
        stage_id: setup.stage_id,
        qualified_stage_id: setup.qualified_stage_id,
        instruction: setup.instruction,
        qualification: setup.qualification,
      },
    }));
    setManualCampaigns((current) => ({ ...current, [campaignId]: false }));
    await query.refetch();
    setNotice(
      `${t("Agente publicado e selecionado.")} ${result.model_label}. ${t("Revise o ritmo e inicie a campanha quando estiver pronto.")}`,
    );
  }
  const candidates = data?.candidates.filter((c) => c.campaign_id === campaign?.id) ?? [];
  async function perform(body: unknown, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.post("/api/v1/prospecting", body);
      await query.refetch();
      setNotice(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Não foi possível concluir a operação."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const update = <K extends keyof CampaignConfig>(field: K, value: CampaignConfig[K]) =>
    setConfig((c) => ({ ...c, [field]: value }));
  function alternarEdicaoDoRitmo(c: Campaign) {
    if (!c.config) return;
    const { daily_limit, interval_minutes } = c.config;
    setRitmo((atual) =>
      atual?.campaignId === c.id ? null : { campaignId: c.id, daily_limit, interval_minutes },
    );
  }
  const ritmoValido =
    !!ritmo &&
    Number.isInteger(ritmo.daily_limit) &&
    ritmo.daily_limit >= 1 &&
    ritmo.daily_limit <= 50 &&
    Number.isInteger(ritmo.interval_minutes) &&
    ritmo.interval_minutes >= 5 &&
    ritmo.interval_minutes <= 1440;
  async function salvarRitmo() {
    if (!ritmo || !ritmoValido) return;
    const salvou = await perform(
      {
        action: "adjust_pace",
        id: ritmo.campaignId,
        daily_limit: ritmo.daily_limit,
        interval_minutes: ritmo.interval_minutes,
      },
      t("Ritmo atualizado. A campanha continua pausada."),
    );
    if (salvou) setRitmo(null);
  }
  const count = (states: string[]) => candidates.filter((c) => states.includes(c.progress)).length;
  const buscaConcluida = !!campaign && campaign.search_status === "succeeded";
  const noRascunho = buscaConcluida && campaign?.status === "draft";
  // Depois de iniciada, a fila só se mexe com a campanha PAUSADA: o envio não está no meio
  // de uma abordagem. Quem já foi abordado, falhou ou está sendo preparado não muda.
  const naFilaPausada = buscaConcluida && campaign?.status === "paused";
  const canSelect = noRascunho || naFilaPausada;
  const criaSoNoEnvio = campaign?.config?.funnel_entry === "on_send";
  /** Linha que a caixa pode alterar agora. Espelha as regras do servidor (`selecionarNaFila`). */
  const marcavel = (c: Candidate) => {
    if (noRascunho) return true;
    if (c.status === "queued") return true;
    return (
      c.status === "skipped" &&
      c.selected === false &&
      c.error === RAZAO_NAO_SELECIONADA &&
      (criaSoNoEnvio || !!c.conversation_id)
    );
  };
  const elegiveis = canSelect ? candidates.filter(marcavel) : [];
  const allSelected = elegiveis.length > 0 && elegiveis.every((c) => c.selected !== false);
  // Critério do #2048, medido sobre as linhas que a caixa pode alterar agora, não a fila inteira.
  const noneSelected = elegiveis.every((c) => c.selected === false);
  const desmarcadas = candidates.filter((c) => c.selected === false);
  /**
   * O que o botão "Excluir desmarcadas" realmente apaga. Espelha o `where` do servidor: sem
   * negócio nem conversa (o que já virou registro do CRM não é daqui) e só o que o operador
   * tirou. Numa campanha que criou o contato ao iniciar, toda desmarcada da fila já tem
   * conversa — e o botão não aparece, em vez de dizer "excluído" sem ter excluído nada.
   * (A linha-tomba de LGPD tem `error` nulo, então também fica de fora.)
   */
  const descartaveis = desmarcadas.filter(
    (c) =>
      !c.conversation_id &&
      !c.lead_id &&
      (c.status === "new" || (c.status === "skipped" && c.error === RAZAO_NAO_SELECIONADA)),
  );
  const visiveis =
    canSelect && !mostrarDesmarcadas ? candidates.filter((c) => c.selected !== false) : candidates;
  async function setSelection(candidateIds: string[], selected: boolean) {
    if (!campaign) return;
    await perform(
      {
        action: noRascunho ? "select" : "select_in_queue",
        id: campaign.id,
        candidate_ids: candidateIds,
        selected,
      },
      t("Seleção da fila atualizada."),
    );
  }
  async function excluirDesmarcadas() {
    if (!campaign) return;
    const excluiu = await perform(
      { action: "discard_unselected", id: campaign.id },
      t("Empresas desmarcadas excluídas."),
    );
    if (excluiu) setConfirmandoExclusao(false);
  }
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">CRM</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t("Prospecção")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t("Encontre empresas, aborde aos poucos e acompanhe quem avança na conversa.")}
          </p>
        </div>
        <Button variant="outline" onClick={() => setSettings((s) => !s)}>
          {t("Configurar busca")}
        </Button>
      </header>
      {(error || query.error) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive p-4 text-sm text-destructive"
        >
          {error ??
            (query.error instanceof Error
              ? query.error.message
              : t("Falha ao carregar a prospecção."))}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
        </div>
      )}
      {!data && !query.error && <p role="status">{t("Carregando campanhas…")}</p>}
      {(settings || data?.configured === false) && (
        <Card className="p-5">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await perform({ action: "configure", api_key: key }, t("Chave de busca salva."))
              ) {
                setKey("");
                setSettings(false);
              }
            }}
          >
            <div className="flex-1">
              <Label htmlFor="prospecting-key">{t("Chave da Apify")}</Label>
              <Input
                id="prospecting-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                required
                minLength={10}
                className="mt-2"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("A chave fica cifrada no servidor. Cada busca tem seu próprio limite de gasto.")}
              </p>
            </div>
            <Button disabled={busy || !key} type="submit">
              {t("Salvar chave")}
            </Button>
          </form>
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="flex flex-col gap-5">
          <Card className="p-5">
            <h2 className="text-lg font-semibold">{t("1. Encontrar empresas")}</h2>
            <form
              className="mt-4 space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const fingerprint = JSON.stringify([niche, location, limit, budget, enrich]);
                if (searchAttempt.current?.fingerprint !== fingerprint)
                  searchAttempt.current = { fingerprint, id: randomId() };
                const success = await perform(
                  {
                    action: "search",
                    request_id: searchAttempt.current.id,
                    search: {
                      name: `${niche} · ${location}`.slice(0, 120),
                      niche,
                      location,
                      limit,
                      budget_usd: budget,
                      enrich,
                    },
                  },
                  t("Solicitação registrada. Acompanhe o estado da busca nesta tela."),
                );
                if (success) {
                  setSelected(null);
                  searchAttempt.current = null;
                }
              }}
            >
              <div>
                <Label htmlFor="prospecting-niche">{t("Público ou segmento")}</Label>
                <Input
                  id="prospecting-niche"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder={t("Ex.: clínicas de estética")}
                  minLength={2}
                  maxLength={120}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="prospecting-location">{t("Cidade ou região")}</Label>
                <Input
                  id="prospecting-location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={t("Ex.: São Paulo, SP")}
                  minLength={2}
                  maxLength={160}
                  required
                  className="mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="prospecting-limit">{t("Até quantas empresas")}</Label>
                  <Input
                    id="prospecting-limit"
                    type="number"
                    min={1}
                    max={100}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    required
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="prospecting-budget">{t("Teto da busca (US$)")}</Label>
                  <Input
                    id="prospecting-budget"
                    type="number"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={budget}
                    onChange={(e) => setBudget(Number(e.target.value))}
                    required
                    className="mt-1"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enrich}
                  onChange={(e) => setEnrich(e.target.checked)}
                  className="mt-1"
                />
                {t("Enriquecer com e-mails comerciais e redes encontradas no site")}
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  "A pesquisa usa seu saldo da Apify. A quantidade encontrada pode ser menor que o limite. Nenhuma abordagem começa nesta etapa.",
                )}
              </p>
              <Button className="w-full" type="submit" disabled={busy || !data?.configured}>
                {busy ? t("Aguarde…") : t("Buscar empresas")}
              </Button>
            </form>
          </Card>
          <section>
            <h2 className="mb-3 text-sm font-semibold">{t("Suas campanhas")}</h2>
            <div className="space-y-2">
              {data?.campaigns.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setSelected(c.id);
                    setNotice(null);
                    // A confirmação de exclusão vale para UMA campanha: ao trocar, ela some.
                    setConfirmandoExclusao(false);
                    setMostrarDesmarcadas(false);
                  }}
                  className={`w-full rounded-lg border p-3 text-left ${campaign?.id === c.id ? "border-primary bg-primary/5" : "bg-card"}`}
                >
                  <span className="block text-sm font-medium">{c.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(labels[c.status] ?? c.status)} · {c.result_count} {t("empresas")}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
        <div className="min-w-0 space-y-5">
          {!campaign && (
            <Card className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center">
              <h2 className="text-xl font-semibold">{t("Sua próxima conversa começa aqui")}</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {t(
                  "Escolha um segmento e uma região. Depois da pesquisa, defina como a IA deve abordar e o que precisa confirmar para qualificar.",
                )}
              </p>
            </Card>
          )}
          {campaign && (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{campaign.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t(labels[campaign.search_status] ?? campaign.search_status)}
                      {campaign.cost_usd !== null
                        ? ` · US$ ${Number(campaign.cost_usd).toFixed(2)}`
                        : ""}
                    </p>
                  </div>
                  <Badge variant="outline">{t(labels[campaign.status] ?? campaign.status)}</Badge>
                </div>
                {campaign.error && (
                  <p role="alert" className="mt-4 rounded-md bg-destructive/10 p-3 text-sm">
                    {campaign.error}
                  </p>
                )}
                <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
                  {[
                    [t("Encontrados"), candidates.length],
                    [t("Na fila"), count(["queued", "sending"])],
                    [t("Responderam"), count(["replied", "qualified"])],
                    [t("Qualificados"), count(["qualified"])],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-2xl font-semibold tabular-nums">{value}</p>
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
                {campaign.skipped_count > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {campaign.skipped_count}{" "}
                    {t("resultados repetidos ou indisponíveis foram desconsiderados.")}
                  </p>
                )}
                {campaign.config && (
                  <>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                      <p className="text-sm text-muted-foreground">
                        {t("Ritmo:")} {campaign.config.daily_limit}{" "}
                        {t("abordagens em 24 horas, com pelo menos")}{" "}
                        {campaign.config.interval_minutes} {t("minutos entre elas.")}
                      </p>
                      {campaign.status === "running" ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            perform(
                              { action: "pause", id: campaign.id },
                              t("Novas abordagens pausadas."),
                            )
                          }
                        >
                          {t("Pausar abordagens")}
                        </Button>
                      ) : campaign.status === "paused" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => alternarEdicaoDoRitmo(campaign)}
                          >
                            {t("Editar ritmo")}
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              perform(
                                { action: "resume", id: campaign.id },
                                t("Campanha retomada."),
                              )
                            }
                          >
                            {t("Retomar fila")}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {campaign.status === "paused" && ritmo?.campaignId === campaign.id && (
                      <form
                        className="mt-4 space-y-3 rounded-md border p-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void salvarRitmo();
                        }}
                      >
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="prospecting-pace-daily">
                              {t("Máximo em 24 horas")}
                            </Label>
                            <Input
                              id="prospecting-pace-daily"
                              type="number"
                              min={1}
                              max={50}
                              required
                              value={ritmo.daily_limit}
                              onChange={(e) =>
                                setRitmo({ ...ritmo, daily_limit: Number(e.target.value) })
                              }
                              className="mt-1"
                            />
                          </div>
                          <div>
                            <Label htmlFor="prospecting-pace-spacing">
                              {t("Intervalo mínimo (minutos)")}
                            </Label>
                            <Input
                              id="prospecting-pace-spacing"
                              type="number"
                              min={5}
                              max={1440}
                              required
                              value={ritmo.interval_minutes}
                              onChange={(e) =>
                                setRitmo({ ...ritmo, interval_minutes: Number(e.target.value) })
                              }
                              className="mt-1"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "Só dá para ajustar com a campanha pausada. Ao retomar, o próximo envio já usa o ritmo novo. Limite de 1 a 50 por dia e intervalo de 5 a 1440 minutos.",
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button type="submit" disabled={busy || !ritmoValido}>
                            {t("Salvar ritmo")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setRitmo(null)}
                          >
                            {t("Cancelar")}
                          </Button>
                        </div>
                      </form>
                    )}
                  </>
                )}
              </Card>
              {campaign.status === "draft" &&
                campaign.search_status === "succeeded" &&
                candidates.length > 0 && (
                  <Card className="p-5">
                    <h2 className="text-lg font-semibold">{t("2. Preparar a abordagem")}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t(
                        "A IA usa o agente escolhido para abrir a conversa e atender as respostas. As proteções do canal continuam valendo.",
                      )}
                    </p>
                    {!campaign.config && (
                      <div className="mt-4 space-y-4">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant={!manual ? "secondary" : "outline"}
                            onClick={() =>
                              setManualCampaigns((current) => ({
                                ...current,
                                [campaign.id]: false,
                              }))
                            }
                          >
                            {t("Configurar por conversa")}
                          </Button>
                          <Button
                            type="button"
                            variant={manual ? "secondary" : "outline"}
                            onClick={() =>
                              setManualCampaigns((current) => ({ ...current, [campaign.id]: true }))
                            }
                          >
                            {t("Usar agente existente / configurar manualmente")}
                          </Button>
                        </div>
                        {!manual && !config.agent_id && data && (
                          <ProspectingAgentBuilder
                            key={campaign.id}
                            campaign={campaign}
                            config={config}
                            channels={data.channels}
                            stages={data.stages}
                            onCreated={selectCreatedAgent}
                          />
                        )}
                        {!manual && config.agent_id && (
                          <section
                            aria-label={t("Agente selecionado")}
                            className="space-y-2 rounded-xl border bg-muted/20 p-4 text-sm"
                          >
                            <p className="font-semibold">
                              {agents.find((agent) => agent.id === config.agent_id)?.name ??
                                t("Agente selecionado")}
                            </p>
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              {config.instruction}
                            </p>
                            <div className="flex flex-wrap gap-4">
                              <Link
                                className="underline"
                                href={`/app/ai/agents/${config.agent_id}`}
                              >
                                {t("Configurações avançadas do agente")}
                              </Link>
                              <Link
                                className="underline"
                                href={`/app/ai/agents/${config.agent_id}#voice-assistant`}
                              >
                                {t("Configurar assistente de voz")}
                              </Link>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t(
                                "Agente pronto. Escolha o ritmo abaixo e inicie quando estiver preparado.",
                              )}
                            </p>
                          </section>
                        )}
                      </div>
                    )}
                    {(manual || config.agent_id) && (
                      <form
                        className="mt-5 space-y-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void perform(
                            { action: "start", id: campaign.id, config },
                            t(
                              "Campanha iniciada. A primeira abordagem será preparada após um minuto.",
                            ),
                          );
                        }}
                      >
                        {campaign.config && (
                          <p className="text-sm text-muted-foreground">
                            {t(
                              "Esta campanha já começou a preparar contatos. Sua configuração foi preservada para retomar com segurança.",
                            )}
                          </p>
                        )}
                        <fieldset disabled={!!campaign.config} className="space-y-4">
                          {manual && (
                            <div className="space-y-4">
                              <div className="grid gap-4 md:grid-cols-2">
                                <div>
                                  <Label htmlFor="prospecting-agent">{t("Agente de IA")}</Label>
                                  <select
                                    id="prospecting-agent"
                                    className={`${selectClass} mt-1`}
                                    value={config.agent_id}
                                    onChange={(e) => update("agent_id", e.target.value)}
                                    required
                                  >
                                    <option value="">{t("Escolha um agente publicado")}</option>
                                    {agents.map((a) => (
                                      <option key={a.id} value={a.id}>
                                        {a.name}
                                      </option>
                                    ))}
                                  </select>
                                  {config.agent_id && (
                                    <Link
                                      className="mt-2 block text-xs underline"
                                      href={`/app/ai/agents/${config.agent_id}`}
                                    >
                                      {t("Configurações avançadas do agente")}
                                    </Link>
                                  )}
                                </div>
                                <div>
                                  <Label htmlFor="prospecting-channel">
                                    {t("Conexão de saída")}
                                  </Label>
                                  <select
                                    id="prospecting-channel"
                                    className={`${selectClass} mt-1`}
                                    value={config.channel_session_id}
                                    onChange={(e) => update("channel_session_id", e.target.value)}
                                    required
                                  >
                                    <option value="">{t("Escolha uma conexão ativa")}</option>
                                    {data?.channels
                                      .filter((c) => c.status === "WORKING")
                                      .map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.display_name ?? c.phone_number ?? c.id}
                                        </option>
                                      ))}
                                  </select>
                                  <Link className="text-xs underline" href="/app/connections">
                                    {t("Ver conexões e proteções de envio")}
                                  </Link>
                                </div>
                              </div>
                              <div>
                                <Label htmlFor="prospecting-pipeline">{t("Funil")}</Label>
                                <select
                                  id="prospecting-pipeline"
                                  className={`${selectClass} mt-1`}
                                  value={funil}
                                  required
                                  onChange={(e) => {
                                    setConfig((c) => ({
                                      ...c,
                                      pipeline_id: e.target.value,
                                      stage_id: "",
                                      qualified_stage_id: "",
                                    }));
                                  }}
                                >
                                  <option value="">{t("Escolha o funil")}</option>
                                  {[
                                    ...new Map(
                                      data?.stages.map((s) => [s.pipeline_id, s.pipeline_name]),
                                    ).entries(),
                                  ].map(([id, name]) => (
                                    <option key={id} value={id}>
                                      {name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="grid gap-4 md:grid-cols-2">
                                {(
                                  [
                                    ["stage_id", "Etapa inicial"],
                                    ["qualified_stage_id", "Etapa de qualificados"],
                                  ] as const
                                ).map(([field, label]) => (
                                  <div key={field}>
                                    <Label htmlFor={`prospecting-${field}`}>{t(label)}</Label>
                                    <select
                                      id={`prospecting-${field}`}
                                      className={`${selectClass} mt-1`}
                                      required
                                      value={config[field]}
                                      onChange={(e) => update(field, e.target.value)}
                                    >
                                      <option value="">{t("Escolha a etapa")}</option>
                                      {data?.stages
                                        .filter((s) => s.pipeline_id === funil)
                                        .map((s) => (
                                          <option key={s.id} value={s.id}>
                                            {s.name}
                                          </option>
                                        ))}
                                    </select>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <Label htmlFor="prospecting-instruction">
                                  {t("O que a IA deve oferecer e como iniciar")}
                                </Label>
                                <Textarea
                                  id="prospecting-instruction"
                                  value={config.instruction}
                                  onChange={(e) => update("instruction", e.target.value)}
                                  required
                                  minLength={10}
                                  maxLength={2000}
                                  className="mt-1"
                                  placeholder={t(
                                    "Descreva sua oferta e o objetivo da primeira conversa.",
                                  )}
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t(
                                    "Este texto se soma ao prompt do agente nas conversas desta campanha. Se você mudar o prompt do agente, confira se os dois ainda dizem a mesma coisa.",
                                  )}
                                </p>
                              </div>
                              <div>
                                <Label htmlFor="prospecting-qualification">
                                  {t("Quando considerar o cliente qualificado")}
                                </Label>
                                <Textarea
                                  id="prospecting-qualification"
                                  value={config.qualification}
                                  onChange={(e) => update("qualification", e.target.value)}
                                  required
                                  minLength={10}
                                  maxLength={2000}
                                  className="mt-1"
                                  placeholder={t(
                                    "Ex.: confirmou a necessidade, participa da decisão e deseja conversar sobre a solução.",
                                  )}
                                />
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <Label htmlFor="prospecting-daily">{t("Máximo em 24 horas")}</Label>
                              <Input
                                id="prospecting-daily"
                                type="number"
                                min={1}
                                max={50}
                                required
                                value={config.daily_limit}
                                onChange={(e) => update("daily_limit", Number(e.target.value))}
                                className="mt-1"
                              />
                            </div>
                            <div>
                              <Label htmlFor="prospecting-spacing">
                                {t("Intervalo mínimo (minutos)")}
                              </Label>
                              <Input
                                id="prospecting-spacing"
                                type="number"
                                min={5}
                                max={1440}
                                required
                                value={config.interval_minutes}
                                onChange={(e) => update("interval_minutes", Number(e.target.value))}
                                className="mt-1"
                              />
                            </div>
                          </div>
                          <fieldset className="space-y-2">
                            <legend className="text-sm font-medium">
                              {t("Quando a empresa entra no funil")}
                            </legend>
                            <label className="flex items-start gap-2 text-sm">
                              <input
                                type="radio"
                                name="prospecting-funnel-entry"
                                checked={(config.funnel_entry ?? "on_start") === "on_send"}
                                onChange={() => update("funnel_entry", "on_send")}
                                className="mt-1"
                              />
                              <span>
                                {t("Só quando for abordada (recomendado)")}
                                <span className="block text-xs text-muted-foreground">
                                  {t("O funil mostra só quem já recebeu a primeira mensagem.")}
                                </span>
                              </span>
                            </label>
                            <label className="flex items-start gap-2 text-sm">
                              <input
                                type="radio"
                                name="prospecting-funnel-entry"
                                checked={(config.funnel_entry ?? "on_start") === "on_start"}
                                onChange={() => update("funnel_entry", "on_start")}
                                className="mt-1"
                              />
                              <span>
                                {t("Todas ao iniciar")}
                                <span className="block text-xs text-muted-foreground">
                                  {t(
                                    "Contato, negócio e conversa de toda a fila são criados na hora de iniciar.",
                                  )}
                                </span>
                              </span>
                            </label>
                          </fieldset>
                          <div>
                            <Label htmlFor="prospecting-basis">
                              {t("Referência da avaliação de legítimo interesse")}
                            </Label>
                            <Input
                              id="prospecting-basis"
                              value={config.legal_basis_ref}
                              onChange={(e) => update("legal_basis_ref", e.target.value)}
                              minLength={3}
                              maxLength={500}
                              required
                              className="mt-1"
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t(
                                "Informe a referência real da avaliação que fundamenta esta prospecção. Isso não registra consentimento dos contatos.",
                              )}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {(config.funnel_entry ?? "on_start") === "on_send"
                              ? t(
                                  "Ao iniciar, as empresas com telefone entram na fila. Cada uma entra no funil só quando for abordada. Contatos já existentes são preservados. A fila faz uma primeira abordagem; respostas seguem no Inbox. Uma mensagem já em transmissão pode concluir após a pausa.",
                                )
                              : t(
                                  "Ao iniciar, os contatos novos com telefone entram no funil. Contatos já existentes são preservados. A fila faz uma primeira abordagem; respostas seguem no Inbox. Uma mensagem já em transmissão pode concluir após a pausa.",
                                )}
                          </p>
                        </fieldset>
                        <Button
                          type="submit"
                          disabled={
                            busy ||
                            !agents.length ||
                            !data?.channels.some((c) => c.status === "WORKING")
                          }
                        >
                          {t("Iniciar abordagens com IA")}
                        </Button>
                      </form>
                    )}
                  </Card>
                )}
              {candidates.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold">{t("3. Acompanhar resultados")}</h2>
                        <p className="text-sm text-muted-foreground">
                          {t(
                            "Encontrado é diferente de qualificado. A qualificação depende do que for confirmado na conversa.",
                          )}
                        </p>
                      </div>
                      {canSelect && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {noRascunho
                              ? t(
                                  "Somente as empresas marcadas entram na fila ao iniciar as abordagens.",
                                )
                              : t(
                                  "Com a campanha pausada, marque ou desmarque as empresas que ainda estão na fila. Quem já foi abordado não muda.",
                                )}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || elegiveis.length === 0 || allSelected}
                            onClick={() =>
                              setSelection(
                                elegiveis.map((c) => c.id),
                                true,
                              )
                            }
                          >
                            {t("Marcar todas")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || noneSelected}
                            onClick={() =>
                              setSelection(
                                elegiveis.map((c) => c.id),
                                false,
                              )
                            }
                          >
                            {t("Desmarcar todas")}
                          </Button>
                          {desmarcadas.length > 0 && (
                            <button
                              type="button"
                              className="text-xs underline"
                              onClick={() => setMostrarDesmarcadas((v) => !v)}
                            >
                              {mostrarDesmarcadas
                                ? t("Esconder desmarcadas")
                                : `${t("Mostrar desmarcadas")} (${desmarcadas.length})`}
                            </button>
                          )}
                          {descartaveis.length > 0 &&
                            (confirmandoExclusao ? (
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {t(
                                    "Excluir tira essas empresas da lista. Em outra busca, elas podem aparecer de novo como novas.",
                                  )}
                                </span>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void excluirDesmarcadas()}
                                >
                                  {t("Confirmar exclusão")}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => setConfirmandoExclusao(false)}
                                >
                                  {t("Cancelar")}
                                </Button>
                              </span>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => setConfirmandoExclusao(true)}
                              >
                                {`${t("Excluir desmarcadas")} (${descartaveis.length})`}
                              </Button>
                            ))}
                          {naFilaPausada && !criaSoNoEnvio && (
                            <span className="basis-full text-xs text-muted-foreground">
                              {t(
                                "Esta campanha já criou o contato e o negócio dessas empresas ao iniciar. Desmarcar só impede o envio: elas continuam no funil.",
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                        <tr>
                          {canSelect && (
                            <th className="p-4">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={allSelected}
                                  disabled={busy || elegiveis.length === 0}
                                  onChange={() =>
                                    setSelection(
                                      elegiveis.map((c) => c.id),
                                      !allSelected,
                                    )
                                  }
                                  aria-label={t("Alternar seleção de todas as empresas")}
                                />
                                <span>{t("Abordar")}</span>
                              </label>
                            </th>
                          )}
                          <th className="p-4">{t("Empresa")}</th>
                          <th className="p-4">{t("Informações")}</th>
                          <th className="p-4">{t("Progresso")}</th>
                          <th className="p-4">{t("Conversa")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiveis.map((c) => (
                          <tr key={c.id} className="border-b last:border-0">
                            {canSelect && (
                              <td className="p-4 align-top">
                                {marcavel(c) && (
                                  <input
                                    type="checkbox"
                                    checked={c.selected !== false}
                                    disabled={busy}
                                    onChange={() => setSelection([c.id], c.selected === false)}
                                    aria-label={t("Marcar empresa para abordagem")}
                                  />
                                )}
                              </td>
                            )}
                            <td className="p-4 align-top">
                              <p className="font-medium">{c.data.name}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {c.data.category}
                              </p>
                              <p className="mt-1 text-xs">{c.data.phone ?? t("Sem telefone")}</p>
                            </td>
                            <td className="max-w-64 p-4 align-top">
                              <p className="text-xs text-muted-foreground">{c.data.address}</p>
                              {safePublicLink(c.data.website) && (
                                <a
                                  className="mt-1 block underline"
                                  href={safePublicLink(c.data.website)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {t("Site da empresa")}
                                </a>
                              )}
                              <p className="mt-1 text-xs text-muted-foreground">
                                {c.data.rating ?? "—"} ★ · {c.data.reviews ?? 0} {t("avaliações")}
                              </p>
                              {c.data.emails.map((email) => (
                                <p key={email} className="mt-1 text-xs break-all">
                                  {email}
                                </p>
                              ))}
                            </td>
                            <td className="max-w-64 p-4 align-top">
                              <Badge variant="outline">{t(labels[c.progress] ?? c.progress)}</Badge>
                              {c.error && (
                                <p className="mt-2 text-xs text-muted-foreground">{c.error}</p>
                              )}
                              {c.message_status && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t("Mensagem:")} {c.message_status}
                                </p>
                              )}
                            </td>
                            <td className="p-4 align-top">
                              {c.conversation_id && (
                                <Link
                                  className="underline"
                                  href={`/app/inbox?id=${c.conversation_id}`}
                                >
                                  {t("Abrir no Inbox")}
                                </Link>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
