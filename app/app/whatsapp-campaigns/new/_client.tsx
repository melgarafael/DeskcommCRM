"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";

interface SessionRow {
  id: string;
  label: string | null;
  status: string;
  phone_number: string | null;
}

interface ContactPick {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string;
}

interface PreviewSample {
  phone: string;
  name: string | null;
  company: string | null;
  message: string;
}

const STEPS = [
  "Nome",
  "Público",
  "Mensagem",
  "WhatsApp",
  "Envio",
  "Revisão",
] as const;

export function WhatsappCampaignWizardClient() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [messageText, setMessageText] = useState(
    "Olá, {{first_name}}. Tudo bem?\nEstou entrando em contato sobre a {{company_name}}.",
  );
  const [sessionId, setSessionId] = useState("");
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [multiSession, setMultiSession] = useState(false);
  const [replyStopMode, setReplyStopMode] = useState<"none" | "person" | "company">("person");
  const [createLeadOnReply, setCreateLeadOnReply] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [minInterval, setMinInterval] = useState(20);
  const [maxInterval, setMaxInterval] = useState(45);
  const [windowStart, setWindowStart] = useState("08:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [dailyLimit, setDailyLimit] = useState<string>("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [contactHits, setContactHits] = useState<ContactPick[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [companyIdsRaw, setCompanyIdsRaw] = useState("");
  const [personIdsRaw, setPersonIdsRaw] = useState("");
  const [importBatchId, setImportBatchId] = useState("");

  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [materialize, setMaterialize] = useState<{
    total: number;
    eligible: number;
    skipped: number;
    skipped_reasons: Record<string, number>;
  } | null>(null);
  const [previews, setPreviews] = useState<PreviewSample[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/v1/channel-sessions");
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : [];
      setSessions(
        list
          .filter((s: { status?: string }) => s.status === "WORKING")
          .map((s: { id: string; display_name?: string | null; status: string; phone_number?: string | null }) => ({
            id: s.id,
            label: s.display_name ?? null,
            status: s.status,
            phone_number: s.phone_number ?? null,
          })),
      );
    })();
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    const timer = setTimeout(() => {
      void (async () => {
        const qs = contactSearch
          ? `?search=${encodeURIComponent(contactSearch)}&limit=20`
          : "?limit=20";
        const res = await fetch(`/api/v1/contacts${qs}`);
        const json = await res.json();
        setContactHits(Array.isArray(json.data) ? json.data : []);
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [contactSearch, step]);

  const selectedSessions = multiSession
    ? sessionIds
    : sessionId
      ? [sessionId]
      : [];

  const perSessionEstimate = useMemo(() => {
    const n = materialize?.eligible ?? 0;
    const k = selectedSessions.length || 1;
    if (n <= 0) return null;
    return Math.round(n / k);
  }, [materialize, selectedSessions.length]);

  const estimateMinutes = useMemo(() => {
    const n = materialize?.eligible ?? 0;
    if (n <= 0) return null;
    const avg = (minInterval + maxInterval) / 2;
    const parallel = Math.max(1, selectedSessions.length);
    return Math.round((n * avg) / 60 / parallel);
  }, [materialize, minInterval, maxInterval, selectedSessions.length]);

  const toggleContact = useCallback((id: string) => {
    setSelectedContactIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleSession = useCallback((id: string) => {
    setSessionIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  async function buildAudienceAndPreview() {
    setBusy(true);
    setError(null);
    try {
      let id = campaignId;
      if (!id) {
        const createRes = await fetch("/api/v1/whatsapp-campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description: description || null,
            message_text: messageText,
            channel_session_ids: selectedSessions,
            reply_stop_mode: replyStopMode,
            create_lead_on_reply: createLeadOnReply,
            min_interval_seconds: minInterval,
            max_interval_seconds: maxInterval,
            send_window_start: windowStart || null,
            send_window_end: windowEnd || null,
            timezone,
            daily_limit: dailyLimit ? Number(dailyLimit) : null,
            scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          }),
        });
        const createJson = await createRes.json();
        if (!createRes.ok) {
          setError(createJson.error?.message ?? t("Não foi possível criar a campanha."));
          return;
        }
        id = createJson.data.id as string;
        setCampaignId(id);
      }

      const selection: Record<string, unknown> = {};
      if (selectedContactIds.length) selection.contact_ids = selectedContactIds;
      const companies = companyIdsRaw
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const people = personIdsRaw
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (companies.length) selection.company_ids = companies;
      if (people.length) selection.person_ids = people;
      if (importBatchId.trim()) selection.import_batch_id = importBatchId.trim();

      const recRes = await fetch(`/api/v1/whatsapp-campaigns/${id}/recipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const recJson = await recRes.json();
      if (!recRes.ok) {
        setError(recJson.error?.message ?? t("Falha ao materializar destinatários."));
        return;
      }
      setMaterialize(recJson.data);

      const prevRes = await fetch(`/api/v1/whatsapp-campaigns/${id}/preview`, {
        method: "POST",
      });
      const prevJson = await prevRes.json();
      setPreviews(Array.isArray(prevJson.data?.samples) ? prevJson.data.samples : []);
      setStep(5);
    } finally {
      setBusy(false);
    }
  }

  async function startCampaign() {
    if (!campaignId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/whatsapp-campaigns/${campaignId}/start`, {
      method: "POST",
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error?.message ?? t("Não foi possível iniciar."));
      return;
    }
    router.push(`/app/whatsapp-campaigns/${campaignId}`);
  }

  function canNext(): boolean {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) {
      return (
        selectedContactIds.length > 0 ||
        companyIdsRaw.trim().length > 0 ||
        personIdsRaw.trim().length > 0 ||
        importBatchId.trim().length > 0
      );
    }
    if (step === 2) return messageText.trim().length > 0;
    if (step === 3) return selectedSessions.length > 0;
    if (step === 4) return maxInterval >= minInterval && minInterval >= 5;
    return true;
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 md:p-6">
      <div>
        <Link href="/app/whatsapp-campaigns" className="text-sm text-muted-foreground hover:underline">
          ← {t("Campanhas")}
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{t("Nova campanha WhatsApp")}</h1>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={
              i === step
                ? "rounded bg-primary px-2 py-1 text-primary-foreground"
                : i < step
                  ? "rounded bg-muted px-2 py-1"
                  : "rounded px-2 py-1 text-muted-foreground"
            }
          >
            {i + 1}. {t(label)}
          </span>
        ))}
      </div>

      <Card className="flex flex-col gap-4 p-4">
        {step === 0 && (
          <>
            <div className="grid gap-1.5">
              <Label>{t("Nome da campanha")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Descrição (opcional)")}</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="text-sm text-muted-foreground">
              {t("Selecione contatos, ou cole UUIDs de pessoas/empresas, ou um lote de importação.")}
            </p>
            <div className="grid gap-1.5">
              <Label>{t("Buscar contatos")}</Label>
              <Input
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder={t("Nome ou telefone")}
                autoComplete="new-password"
              />
            </div>
            <ul className="max-h-48 space-y-1 overflow-auto text-sm">
              {contactHits.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedContactIds.includes(c.id)}
                      onChange={() => toggleContact(c.id)}
                    />
                    <span>
                      {c.display_name || c.name || c.phone_number}{" "}
                      <span className="text-muted-foreground">{c.phone_number}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="grid gap-1.5">
              <Label>{t("IDs de empresas (opcional)")}</Label>
              <Input value={companyIdsRaw} onChange={(e) => setCompanyIdsRaw(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("IDs de pessoas (opcional)")}</Label>
              <Input value={personIdsRaw} onChange={(e) => setPersonIdsRaw(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("ID do lote de importação (opcional)")}</Label>
              <Input value={importBatchId} onChange={(e) => setImportBatchId(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Selecionados")}: {selectedContactIds.length}
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <div className="grid gap-1.5">
              <Label>{t("Mensagem")}</Label>
              <Textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={8}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Variáveis")}: {"{{first_name}}"} {"{{full_name}}"} {"{{company_name}}"}{" "}
              {"{{trade_name}}"}
            </p>
          </>
        )}

        {step === 3 && (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t("WhatsApps utilizados")}</Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={!multiSession}
                  onChange={() => {
                    setMultiSession(false);
                    setSessionIds([]);
                  }}
                />
                {t("Uma conexão")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={multiSession}
                  onChange={() => {
                    setMultiSession(true);
                    if (sessionId) setSessionIds([sessionId]);
                  }}
                />
                {t("Múltiplas conexões")}
              </label>
            </div>

            {!multiSession ? (
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">{t("Selecione…")}</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {(s.label || s.phone_number || s.id.slice(0, 8)) + ` (${s.status})`}
                  </option>
                ))}
              </select>
            ) : (
              <ul className="space-y-2 text-sm">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={sessionIds.includes(s.id)}
                        onChange={() => toggleSession(s.id)}
                      />
                      <span>
                        {s.label || s.phone_number || s.id.slice(0, 8)}{" "}
                        <span className="text-muted-foreground">
                          {s.phone_number} · {s.status}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {multiSession && (
              <p className="text-xs text-muted-foreground">
                {t("Estratégia")}: Round-robin
              </p>
            )}

            <div className="grid gap-2 border-t pt-4">
              <Label>{t("Ao receber resposta")}</Label>
              {(
                [
                  ["none", "Continuar normalmente"],
                  ["person", "Parar outros números da mesma pessoa"],
                  ["company", "Parar todos os contatos da empresa"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={replyStopMode === value}
                    onChange={() => setReplyStopMode(value)}
                  />
                  {t(label)}
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={createLeadOnReply}
                onChange={(e) => setCreateLeadOnReply(e.target.checked)}
              />
              {t("Criar oportunidade quando o cliente responder")}
            </label>
          </div>
        )}

        {step === 4 && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>{t("Intervalo mínimo (s)")}</Label>
                <Input
                  type="number"
                  min={5}
                  value={minInterval}
                  onChange={(e) => setMinInterval(Number(e.target.value))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Intervalo máximo (s)")}</Label>
                <Input
                  type="number"
                  min={5}
                  value={maxInterval}
                  onChange={(e) => setMaxInterval(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>{t("Janela início")}</Label>
                <Input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Janela fim")}</Label>
                <Input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Timezone")}</Label>
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Limite diário (opcional)")}</Label>
              <Input
                type="number"
                min={1}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Agendar início (opcional)")}</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
          </>
        )}

        {step === 5 && materialize && (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">{t("Destinatários")}</dt>
              <dd className="tabular-nums">{materialize.eligible}</dd>
              <dt className="text-muted-foreground">{t("Ignorados")}</dt>
              <dd className="tabular-nums">{materialize.skipped}</dd>
              <dt className="text-muted-foreground">{t("WhatsApps")}</dt>
              <dd>
                <ul className="space-y-0.5">
                  {selectedSessions.map((sid) => {
                    const s = sessions.find((x) => x.id === sid);
                    return (
                      <li key={sid}>{s?.label || s?.phone_number || sid.slice(0, 8)}</li>
                    );
                  })}
                </ul>
              </dd>
              <dt className="text-muted-foreground">{t("Estratégia")}</dt>
              <dd>{selectedSessions.length > 1 ? "Round-robin" : t("Uma conexão")}</dd>
              {perSessionEstimate !== null && selectedSessions.length > 1 && (
                <>
                  <dt className="text-muted-foreground">{t("Projeção por conexão")}</dt>
                  <dd className="tabular-nums">
                    ~{perSessionEstimate}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({t("aproximada")})
                    </span>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t("Ao responder")}</dt>
              <dd>
                {replyStopMode === "none"
                  ? t("Continuar")
                  : replyStopMode === "company"
                    ? t("Parar empresa")
                    : t("Parar pessoa")}
              </dd>
              <dt className="text-muted-foreground">{t("Criar oportunidade")}</dt>
              <dd>{createLeadOnReply ? t("Sim") : t("Não")}</dd>
              <dt className="text-muted-foreground">{t("Pacing")}</dt>
              <dd>
                {minInterval}–{maxInterval}s
              </dd>
              {estimateMinutes !== null && (
                <>
                  <dt className="text-muted-foreground">{t("Duração estimada")}</dt>
                  <dd>
                    ~{estimateMinutes} min{" "}
                    <span className="text-xs text-muted-foreground">
                      ({t("aproximada, não é garantia")})
                    </span>
                  </dd>
                </>
              )}
            </dl>
            <div>
              <h2 className="mb-2 text-sm font-medium">{t("Prévia")}</h2>
              <ul className="space-y-3 text-sm">
                {previews.map((p, i) => (
                  <li key={i} className="rounded border p-3">
                    <div className="font-medium">
                      {p.name || "—"} · {p.company || "—"} · {p.phone}
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-muted-foreground">
                      {p.message}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={step === 0 || busy}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            {t("Voltar")}
          </Button>
          {step < 4 && (
            <Button type="button" disabled={!canNext() || busy} onClick={() => setStep((s) => s + 1)}>
              {t("Continuar")}
            </Button>
          )}
          {step === 4 && (
            <Button type="button" disabled={!canNext() || busy} onClick={() => void buildAudienceAndPreview()}>
              {busy ? t("Preparando…") : t("Revisar")}
            </Button>
          )}
          {step === 5 && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !campaignId}
                onClick={() => campaignId && router.push(`/app/whatsapp-campaigns/${campaignId}`)}
              >
                {t("Salvar rascunho")}
              </Button>
              <Button type="button" disabled={busy || !materialize?.eligible} onClick={() => void startCampaign()}>
                {busy ? t("Iniciando…") : t("Iniciar campanha")}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
