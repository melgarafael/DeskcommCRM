"use client";
/**
 * MergeDialog — read-only scaffolding.
 *
 * Combo-A only delivered the contacts CRUD + LGPD anonymize endpoint. The
 * merge_queue resolve endpoint (`POST /api/v1/merge_queue/[id]/resolve`) is
 * deferred to a follow-up combo. For the MVP this dialog renders the
 * candidates side-by-side but submits no mutation — the action button is a
 * placeholder informing the operator that resolution is not yet wired.
 */
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/browser";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface CandidateSummary {
  id?: string;
  name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  [key: string]: unknown;
}

interface MergeQueueRow {
  id: string;
  candidates: CandidateSummary[] | null;
  status: string;
}

interface Props {
  queueItemId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onResolved?: () => void;
}

export function MergeDialog({ queueItemId, open, onOpenChange }: Props) {
  const t = useT();
  const [item, setItem] = useState<MergeQueueRow | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !queueItemId) return;
    let cancelled = false;
    setLoading(true);
    const supabase = createClient();
    supabase
      .from("merge_queue")
      .select("id, candidates, status")
      .eq("id", queueItemId)
      .maybeSingle()
      .then(({ data }: { data: unknown }) => {
        if (!cancelled) {
          setItem(data as MergeQueueRow | null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, queueItemId]);

  const candidates = item?.candidates ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Resolver merge de clientes")}</DialogTitle>
          <DialogDescription>
            {t(
              "Comparação dos candidatos detectados. A resolução automática via API ainda não está disponível neste MVP — entre em contato com o admin para mesclar via SQL.",
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum candidato disponível.")}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {candidates.map((c, idx) => (
              <div
                key={c.id ?? idx}
                className="rounded-2xl border border-border bg-card p-3 text-sm"
              >
                <div className="font-medium">{c.name ?? "—"}</div>
                <div className="text-muted-foreground">{c.email ?? "—"}</div>
                <div className="text-muted-foreground">{c.phone_number ? phoneForDisplay(c.phone_number) : "—"}</div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Fechar")}
          </Button>
          <Button disabled title={t("Endpoint de resolução não implementado neste MVP")}>
            {t("Resolver via SQL (em breve)")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
