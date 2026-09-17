"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { Eye, ChartBar, Warning } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLgpdPreview, type LgpdPreviewCounts } from "@/hooks/useLgpdPreview";

interface PreviewPanelProps {
  requestId: string;
}

const COUNT_LABELS: Record<keyof LgpdPreviewCounts, string> = {
  conversations: "Conversas",
  messages_total: "Mensagens (total)",
  leads: "Leads",
  orders: "Pedidos",
  activities: "Atividades",
  audit_entries: "Entradas de auditoria",
  consents: "Consentimentos",
};

export function PreviewPanel({ requestId }: PreviewPanelProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [showSample, setShowSample] = useState(false);

  const { data, isLoading, error } = useLgpdPreview(requestId, open);

  const preview = data?.data;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2"
      >
        <Eye size={16} aria-hidden />
        {t("Pré-visualizar dados")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ChartBar size={18} aria-hidden />
              {t("Prévia de dados do titular")}
            </DialogTitle>
          </DialogHeader>

          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-32" />
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <Warning size={16} aria-hidden />
              {t("Falha ao carregar prévia.")}
            </div>
          )}

          {preview && (
            <div className="space-y-4">
              {preview.no_local_footprint && (
                <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300">
                  {t("Nenhum dado local encontrado para este titular.")}
                </div>
              )}

              {/* Contact card */}
              {preview.contact && (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  {/* O telefone aparece logo abaixo, por isso aqui é o NOME e só ele. */}
                  <p className="font-medium">{nomeDoContato(preview.contact) ?? "—"}</p>
                  {preview.contact.email && (
                    <p className="text-muted-foreground">{preview.contact.email}</p>
                  )}
                  {preview.contact.phone_number && (
                    <p className="text-muted-foreground">{preview.contact.phone_number}</p>
                  )}
                  {preview.contact.cpf_present && (
                    <p className="text-xs text-muted-foreground">
                      CPF: {t("presente (valor ocultado)")}
                    </p>
                  )}
                </div>
              )}

              {/* Counts grid */}
              <div className="grid grid-cols-2 gap-3">
                {(Object.entries(preview.counts) as [keyof LgpdPreviewCounts, number][]).map(
                  ([key, value]) => (
                    <Card key={key} className="py-3">
                      <CardHeader className="px-3 pb-0 pt-0">
                        <CardTitle className="text-xs font-normal text-muted-foreground">
                          {t(COUNT_LABELS[key])}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="px-3 pb-0">
                        <p className="text-2xl font-semibold tabular-nums">{value}</p>
                      </CardContent>
                    </Card>
                  ),
                )}
              </div>

              {/* Sample toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSample((v) => !v)}
                className="w-full text-xs"
              >
                {showSample ? t("Ocultar amostra") : t("Expandir amostra (10 itens por categoria)")}
              </Button>

              {showSample && (
                <div className="space-y-4">
                  {preview.sample.conversations.length > 0 && (
                    <SampleBlock label={t("Conversas")} rows={preview.sample.conversations} />
                  )}
                  {preview.sample.messages_recent.length > 0 && (
                    <SampleBlock label={t("Mensagens (recentes)")} rows={preview.sample.messages_recent} />
                  )}
                  {preview.sample.leads.length > 0 && (
                    <SampleBlock label="Leads" rows={preview.sample.leads} />
                  )}
                  {preview.sample.orders.length > 0 && (
                    <SampleBlock label={t("Pedidos")} rows={preview.sample.orders} />
                  )}
                </div>
              )}

              <p className="text-center text-xs text-muted-foreground">
                {t("Gerado em")} {new Date(preview.generated_at).toLocaleString(tagDoIdioma)} · PII{" "}
                {t("mascarada")} · CPF {t("não exibido")}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SampleBlock({ label, rows }: { label: string; rows: unknown[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/20 p-2">
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-all">
          {JSON.stringify(rows, null, 2)}
        </pre>
      </div>
    </div>
  );
}
