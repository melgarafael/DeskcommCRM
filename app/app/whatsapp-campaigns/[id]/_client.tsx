"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";

interface Campaign {
  id: string;
  name: string;
  status: string;
  message_text: string;
  channel_session_id: string;
  reply_stop_mode?: string;
  create_lead_on_reply?: boolean;
  min_interval_seconds: number;
  max_interval_seconds: number;
  send_window_start: string | null;
  send_window_end: string | null;
  timezone: string;
  daily_limit: number | null;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  session_problem: string | null;
  scheduled_at: string | null;
  sessions?: Array<{
    channel_session_id: string;
    enabled: boolean;
    channel_sessions?: {
      display_name?: string | null;
      phone_number?: string | null;
      status?: string;
    };
  }>;
}

interface Stats {
  total: number;
  counts: Record<string, number>;
  reply_rate?: number;
  replied?: number;
  sent_like?: number;
  by_session?: Array<{
    channel_session_id: string;
    label: string;
    phone_number: string | null;
    status: string;
    sent: number;
    failed: number;
    replied: number;
    last_sent_at: string | null;
  }>;
  awaiting_session?: boolean;
}

interface Recipient {
  id: string;
  channel_session_id: string | null;
  phone_number_snapshot: string;
  contact_name_snapshot: string | null;
  person_name_snapshot: string | null;
  company_name_snapshot: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  skipped_reason: string | null;
  sent_at: string | null;
  replied_at: string | null;
  next_attempt_at: string | null;
  uncertainty_resolution: string | null;
}

const FILTERS = [
  { key: "", label: "Todos" },
  { key: "pending", label: "Pendentes" },
  { key: "sent", label: "Enviados" },
  { key: "delivered", label: "Entregues" },
  { key: "read", label: "Lidos" },
  { key: "replied", label: "Respostas" },
  { key: "failed", label: "Falhas" },
  { key: "skipped", label: "Ignorados" },
  { key: "send_uncertain", label: "Incerto" },
] as const;

function skippedLabel(reason: string | null, t: (s: string) => string): string {
  if (!reason) return "";
  const map: Record<string, string> = {
    person_already_replied: "Pessoa já respondeu",
    company_already_replied: "Empresa já respondeu",
    opt_out: "Opt-out",
    blocked: "Bloqueado",
  };
  return t(map[reason] ?? reason);
}

export function WhatsappCampaignDetailClient({ id }: { id: string }) {
  const t = useT();
  const [camp, setCamp] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [cRes, sRes, rRes] = await Promise.all([
      fetch(`/api/v1/whatsapp-campaigns/${id}`),
      fetch(`/api/v1/whatsapp-campaigns/${id}/stats`),
      fetch(
        `/api/v1/whatsapp-campaigns/${id}/recipients${filter ? `?status=${encodeURIComponent(filter)}` : ""}`,
      ),
    ]);
    const cJson = await cRes.json();
    const sJson = await sRes.json();
    const rJson = await rRes.json();
    if (cRes.ok) setCamp(cJson.data);
    if (sRes.ok) setStats(sJson.data);
    if (rRes.ok) setRecipients(Array.isArray(rJson.data) ? rJson.data : []);
  }, [id, filter]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function action(path: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/whatsapp-campaigns/${id}/${path}`, { method: "POST" });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error?.message ?? t("Operação falhou."));
      return;
    }
    void load();
  }

  async function resolveUncertain(
    recipientId: string,
    resolution: "assume_sent" | "retry_anyway",
  ) {
    if (resolution === "retry_anyway") {
      const okConfirm = window.confirm(
        t(
          "Não foi possível confirmar o envio anterior. Reenviar pode resultar em mensagem duplicada. Continuar?",
        ),
      );
      if (!okConfirm) return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/v1/whatsapp-campaigns/${id}/recipients/${recipientId}/resolve-uncertain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      },
    );
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error?.message ?? t("Não foi possível resolver."));
      return;
    }
    void load();
  }

  if (!camp) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>
    );
  }

  const counts = stats?.counts ?? {};
  const sent =
    (counts.sent ?? 0) +
    (counts.delivered ?? 0) +
    (counts.read ?? 0) +
    (counts.replied ?? 0) +
    (counts.assumed_sent ?? 0);
  const total = stats?.total ?? 0;
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;
  const replyRatePct = Math.round((stats?.reply_rate ?? 0) * 1000) / 10;

  const sessionLabel = (sid: string | null) => {
    if (!sid) return "—";
    const fromStats = stats?.by_session?.find((s) => s.channel_session_id === sid);
    if (fromStats) return fromStats.label;
    const fromCamp = camp.sessions?.find((s) => s.channel_session_id === sid);
    return (
      fromCamp?.channel_sessions?.display_name ||
      fromCamp?.channel_sessions?.phone_number ||
      sid.slice(0, 8)
    );
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <Link href="/app/whatsapp-campaigns" className="text-sm text-muted-foreground hover:underline">
          ← {t("Campanhas")}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{camp.name}</h1>
            <p className="text-sm text-muted-foreground">
              {t("Status")}: {camp.status}
              {stats?.awaiting_session
                ? ` · ${t("Aguardando conexão WhatsApp disponível")}`
                : camp.session_problem
                  ? ` · ${camp.session_problem}`
                  : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(camp.status === "draft" || camp.status === "scheduled") && (
              <Button disabled={busy} onClick={() => void action("start")}>
                {t("Iniciar")}
              </Button>
            )}
            {camp.status === "paused" && (
              <Button disabled={busy} onClick={() => void action("resume")}>
                {t("Retomar")}
              </Button>
            )}
            {camp.status === "running" && (
              <Button variant="outline" disabled={busy} onClick={() => void action("pause")}>
                {t("Pausar")}
              </Button>
            )}
            {!["cancelled", "completed"].includes(camp.status) && (
              <Button variant="destructive" disabled={busy} onClick={() => void action("cancel")}>
                {t("Cancelar")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Total", total],
          ["Pendentes", (counts.pending ?? 0) + (counts.scheduled ?? 0)],
          ["Enviados", sent],
          ["Entregues", counts.delivered ?? 0],
          ["Lidos", counts.read ?? 0],
          ["Respostas", counts.replied ?? 0],
          ["Falhas", counts.failed ?? 0],
          ["Incertos", counts.send_uncertain ?? 0],
          ["Ignorados", counts.skipped ?? 0],
          ["Assumidos", counts.assumed_sent ?? 0],
          ["Cancelados", counts.cancelled ?? 0],
        ].map(([label, value]) => (
          <Card key={String(label)} className="p-3">
            <div className="text-xs text-muted-foreground">{t(String(label))}</div>
            <div className="text-2xl font-semibold tabular-nums">{value as number}</div>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{t("Progresso")}</span>
          <span className="tabular-nums">{progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary/80" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-3 text-sm">
          {t("Taxa de resposta")}:{" "}
          <span className="font-medium tabular-nums">
            {stats?.replied ?? 0} / {stats?.sent_like ?? sent} ({replyRatePct}%)
          </span>
        </p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">{t("Pacing")}</dt>
          <dd>
            {camp.min_interval_seconds}–{camp.max_interval_seconds}s
          </dd>
          <dt className="text-muted-foreground">{t("Ao responder")}</dt>
          <dd>{camp.reply_stop_mode ?? "person"}</dd>
          <dt className="text-muted-foreground">{t("Criar oportunidade")}</dt>
          <dd>{camp.create_lead_on_reply ? t("Sim") : t("Não")}</dd>
          <dt className="text-muted-foreground">{t("Janela")}</dt>
          <dd>
            {camp.send_window_start ?? "—"} – {camp.send_window_end ?? "—"} ({camp.timezone})
          </dd>
        </dl>
      </Card>

      {(stats?.by_session?.length ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b px-4 py-3 text-sm font-medium">{t("Por conexão WhatsApp")}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("WhatsApp")}</TableHead>
                <TableHead className="text-right">{t("Enviados")}</TableHead>
                <TableHead className="text-right">{t("Falhas")}</TableHead>
                <TableHead className="text-right">{t("Respostas")}</TableHead>
                <TableHead>{t("Último envio")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats!.by_session!.map((s) => (
                <TableRow key={s.channel_session_id}>
                  <TableCell>
                    {s.label}
                    {s.phone_number ? (
                      <span className="block text-xs text-muted-foreground">{s.phone_number}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.sent}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.failed}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.replied}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.last_sent_at ? new Date(s.last_sent_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>{s.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key || "all"}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            onClick={() => setFilter(f.key)}
          >
            {t(f.label)}
          </Button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Empresa")}</TableHead>
              <TableHead>{t("Pessoa")}</TableHead>
              <TableHead>{t("Telefone")}</TableHead>
              <TableHead>{t("WhatsApp")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Enviado em")}</TableHead>
              <TableHead>{t("Respondido em")}</TableHead>
              <TableHead className="text-right">{t("Tentativas")}</TableHead>
              <TableHead>{t("Detalhe")}</TableHead>
              <TableHead>{t("Ações")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recipients.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-muted-foreground">
                  {t("Nenhum destinatário neste filtro.")}
                </TableCell>
              </TableRow>
            )}
            {recipients.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.company_name_snapshot || "—"}</TableCell>
                <TableCell>{r.person_name_snapshot || r.contact_name_snapshot || "—"}</TableCell>
                <TableCell className="tabular-nums">{r.phone_number_snapshot}</TableCell>
                <TableCell className="text-sm">{sessionLabel(r.channel_session_id)}</TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {r.replied_at ? new Date(r.replied_at).toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.attempt_count}</TableCell>
                <TableCell className="max-w-[14rem] text-sm text-muted-foreground">
                  {r.status === "send_uncertain" ? (
                    <span>
                      {t("Não foi possível confirmar se o WhatsApp recebeu esta mensagem.")}
                    </span>
                  ) : (
                    skippedLabel(r.skipped_reason, t) ||
                    r.last_error ||
                    r.uncertainty_resolution ||
                    ""
                  )}
                </TableCell>
                <TableCell>
                  {r.status === "send_uncertain" && (
                    <div className="flex flex-col gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void resolveUncertain(r.id, "assume_sent")}
                      >
                        {t("Considerar tratado")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void resolveUncertain(r.id, "retry_anyway")}
                      >
                        {t("Reenviar mesmo assim")}
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
