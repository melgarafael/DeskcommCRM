"use client";
import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useProposals,
  useDecidirProposta,
  type DecisaoPassada,
  type PropostaPendente,
} from "@/hooks/leads/useProposals";
import { Check, X } from "@/lib/ui/icons";

function quando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: ptBR });
}

export function ProposalsList({ canDecide }: { canDecide: boolean }) {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const { data, isLoading } = useProposals();
  const decidir = useDecidirProposta();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "history")}>
        <TabsList>
          <TabsTrigger value="pending">
            Aguardando decisão{data ? ` (${data.pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">Já decididas</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : tab === "pending" ? (
        <Pendentes
          itens={data?.pending ?? []}
          canDecide={canDecide}
          pending={decidir.isPending}
          onDecidir={(leadId, decision, seq) => decidir.mutate({ leadId, decision, seq })}
        />
      ) : (
        <Historico itens={data?.history ?? []} />
      )}
    </div>
  );
}

function Pendentes({
  itens,
  canDecide,
  pending,
  onDecidir,
}: {
  itens: PropostaPendente[];
  canDecide: boolean;
  pending: boolean;
  onDecidir: (leadId: string, decision: "approve" | "dismiss", seq: number) => void;
}) {
  if (itens.length === 0) {
    return (
      <Vazio
        titulo="Nenhuma proposta esperando você"
        detalhe="Quando o assistente sugerir um próximo passo, ele aparece aqui — e some daqui assim que você decidir."
      />
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {itens.map((p) => (
        <li key={`${p.lead_id}-${p.seq}`} className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{p.lead_title}</span>
            {p.contact_name && (
              <span className="text-xs text-muted-foreground">· {p.contact_name}</span>
            )}
            {p.stage_name && (
              <Badge variant="secondary" className="text-[11px]">
                {p.stage_name}
              </Badge>
            )}
            {/* Há quanto tempo espera é a informação que decide a ORDEM de quem
                olha — por isso fica na linha do título, não escondida embaixo. */}
            <span className="text-xs text-muted-foreground">
              proposta {quando(p.proposed_at)}
            </span>
          </div>

          <p className="text-sm text-foreground/90">{p.next_action}</p>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canDecide || pending}
              onClick={() => onDecidir(p.lead_id, "approve", p.seq)}
              aria-label={`Aprovar: ${p.next_action}`}
            >
              <Check size={14} aria-hidden />
              Aprovar
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canDecide || pending}
              onClick={() => onDecidir(p.lead_id, "dismiss", p.seq)}
              aria-label={`Ignorar: ${p.next_action}`}
            >
              <X size={14} aria-hidden />
              Ignorar
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Historico({ itens }: { itens: DecisaoPassada[] }) {
  if (itens.length === 0) {
    return (
      <Vazio
        titulo="Nenhuma decisão registrada ainda"
        detalhe="Aprovar e ignorar viram registro — os dois. Quando você decidir a primeira, ela fica aqui."
      />
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {itens.map((d) => (
        <li key={d.activity_id} className="flex flex-col gap-1.5 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* IGNORAR NÃO É "NADA ACONTECEU": ganha o mesmo destaque visual de
                aprovar, porque a wave 4 existe exatamente para que a recusa
                seja uma decisão registrada e não uma ausência. */}
            <Badge variant={d.decision === "approve" ? "success" : "secondary"}>
              {d.decision === "approve" ? "Aprovada" : "Ignorada"}
            </Badge>
            <span className="text-sm font-medium">{d.lead_title}</span>
            <span className="text-xs text-muted-foreground">
              por {d.decided_by ?? "—"} · {quando(d.decided_at)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{d.next_action}</p>
        </li>
      ))}
    </ul>
  );
}

function Vazio({ titulo, detalhe }: { titulo: string; detalhe: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm font-medium">{titulo}</p>
      <p className="max-w-md text-xs text-muted-foreground">{detalhe}</p>
    </div>
  );
}
