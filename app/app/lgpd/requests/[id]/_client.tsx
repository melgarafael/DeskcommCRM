"use client";

import Link from "next/link";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CaretLeft } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLgpdRequest } from "@/hooks/useLgpdRequest";
import { SlaTimeline } from "./SlaTimeline";
import { PreviewPanel } from "./PreviewPanel";
import { ApproveButton } from "./ApproveButton";
import { AuditTrail } from "./AuditTrail";
import type { LgpdRequestStatus, LgpdRequestType } from "@/hooks/useLgpdRequests";

interface Props {
  id: string;
}

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  customer_redact: "Anonimização cliente",
  customer_data_request: "Solicitação de dados",
  store_redact: "Anonimização tenant",
};

const STATUS_LABELS: Record<LgpdRequestStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  pending_review: "Revisão pendente",
};

const STATUS_VARIANT: Record<
  LgpdRequestStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  received: "secondary",
  processing: "default",
  completed: "outline",
  failed: "destructive",
  pending_review: "secondary",
};

export function LgpdRequestDetail({ id }: Props) {
  const { data, isLoading, error } = useLgpdRequest(id);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        Falha ao carregar solicitação.
      </div>
    );
  }

  const { request, audit_trail, signed_pdf_url } = data.data;

  const shortId = request.id.slice(0, 8);
  const typeLabel = TYPE_LABELS[request.request_type] ?? request.request_type;
  const statusLabel = STATUS_LABELS[request.status] ?? request.status;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1 text-muted-foreground">
            <Link href="/app/lgpd/requests">
              <CaretLeft size={14} aria-hidden />
              Solicitações
            </Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight font-mono">
            #{shortId}
          </h1>
          <Badge variant={STATUS_VARIANT[request.status] ?? "secondary"}>
            {statusLabel}
          </Badge>
          <Badge variant="outline">{typeLabel}</Badge>
          {request.emergency && (
            <Badge variant="destructive">Urgente</Badge>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Recebido em{" "}
          {format(new Date(request.received_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
          {request.due_at && (
            <>
              {" · "}
              Vence em{" "}
              {format(new Date(request.due_at), "dd/MM/yyyy", { locale: ptBR })}
            </>
          )}
        </p>
      </div>

      {/* PDF download if completed */}
      {signed_pdf_url && (
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm flex items-center justify-between gap-4">
          <span>Relatório de exportação disponível (expira em 72h).</span>
          <Button size="sm" variant="outline" asChild>
            <a href={signed_pdf_url} download>
              Baixar PDF
            </a>
          </Button>
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3">
        <PreviewPanel requestId={request.id} />
        <ApproveButton
          requestId={request.id}
          requestType={request.request_type}
          status={request.status}
        />
      </div>

      {/* 2-col grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* SLA Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Linha do tempo SLA</CardTitle>
          </CardHeader>
          <CardContent>
            {request.due_at ? (
              <SlaTimeline
                received_at={request.received_at}
                due_at={request.due_at}
                request_type={request.request_type}
              />
            ) : (
              <p className="text-sm text-muted-foreground">SLA não definido.</p>
            )}
          </CardContent>
        </Card>

        {/* Request info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Detalhes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="ID completo" value={request.id} mono />
            <Row label="Tipo" value={typeLabel} />
            <Row label="Status" value={statusLabel} />
            <Row label="Origem" value={request.source ?? "—"} />
            <Row label="Escopo" value={request.scope} />
            <Row label="Tentativas" value={String(request.attempts)} />
            {request.contact_id && (
              <Row label="Contact ID" value={request.contact_id} mono />
            )}
            {request.external_customer_id && (
              <Row label="External customer ID" value={request.external_customer_id} />
            )}
            {request.completed_at && (
              <Row
                label="Concluído em"
                value={format(new Date(request.completed_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
              />
            )}
            {request.error_message && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1">
                <p className="text-xs text-muted-foreground">Erro</p>
                <p className="text-destructive text-xs">{request.error_message}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Audit trail (spans both cols) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Trilha de auditoria ({audit_trail.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AuditTrail entries={audit_trail} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
