"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, Plus } from "@/lib/ui/icons";
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

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  channel_session_id: string;
  created_at: string;
  started_at: string | null;
  stats?: {
    total: number;
    counts: Record<string, number>;
  };
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "Em execução",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
  failed: "Falhou",
};

export function WhatsappCampaignsListClient() {
  const t = useT();
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/v1/whatsapp-campaigns");
    const json = await res.json();
    const list: CampaignRow[] = Array.isArray(json.data) ? json.data : [];
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("Campanhas WhatsApp")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Disparo controlado com pacing, fila persistente e histórico por telefone.")}
          </p>
        </div>
        <Button asChild>
          <Link href="/app/whatsapp-campaigns/new">
            <Plus className="mr-2 size-4" />
            {t("Nova campanha")}
          </Link>
        </Button>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Nome")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead className="text-right">{t("Destinatários")}</TableHead>
              <TableHead className="text-right">{t("Enviados")}</TableHead>
              <TableHead className="text-right">{t("Falhas")}</TableHead>
              <TableHead className="text-right">{t("Pendentes")}</TableHead>
              <TableHead>{t("Data")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  {t("Carregando…")}
                </TableCell>
              </TableRow>
            )}
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                    <Megaphone className="size-8 opacity-40" />
                    <p>{t("Nenhuma campanha ainda.")}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {rows.map((c) => {
              const s = c.stats;
              const sent =
                (s?.counts.sent ?? 0) +
                (s?.counts.delivered ?? 0) +
                (s?.counts.read ?? 0) +
                (s?.counts.replied ?? 0);
              const pending =
                (s?.counts.pending ?? 0) +
                (s?.counts.scheduled ?? 0) +
                (s?.counts.processing ?? 0) +
                (s?.counts.send_uncertain ?? 0);
              const failed = s?.counts.failed ?? 0;
              const total = s?.total ?? 0;
              const progress = total > 0 ? Math.round((sent / total) * 100) : 0;
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      href={`/app/whatsapp-campaigns/${c.id}`}
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      {c.name}
                    </Link>
                    {total > 0 && (
                      <div className="mt-1 h-1.5 w-28 overflow-hidden rounded bg-muted">
                        <div
                          className="h-full bg-primary/80"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{t(STATUS_LABEL[c.status] ?? c.status)}</TableCell>
                  <TableCell className="text-right tabular-nums">{total || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{sent || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{failed || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{pending || "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(c.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
