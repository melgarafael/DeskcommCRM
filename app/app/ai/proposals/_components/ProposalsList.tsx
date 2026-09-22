"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NexusAiApproval } from "@/components/nexus-ui/ai/NexusAiApproval";
import {
  useProposals,
  useDecidirProposta,
  type DecisaoPassada,
  type PropostaPendente,
} from "@/hooks/leads/useProposals";
import { useT } from "@/hooks/i18n/useT";

function quando(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: locale });
}

export function ProposalsList({ canDecide }: { canDecide: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const { data, isLoading } = useProposals();
  const decidir = useDecidirProposta();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "history")}>
        <TabsList>
          <TabsTrigger value="pending">
            {t("Aguardando decisão")}
            {data ? ` (${data.pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">{t("Já decididas")}</TabsTrigger>
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
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (itens.length === 0) {
    return (
      <Vazio
        titulo={t("Nenhuma proposta esperando você")}
        detalhe={t(
          "Quando o assistente sugerir um próximo passo, ele aparece aqui — e some daqui assim que você decidir.",
        )}
      />
    );
  }

  return (
    <ul className="space-y-2">
      {itens.map((p) => (
        <li key={`${p.lead_id}-${p.seq}`}>
          {/* Mesmo contrato do botão anterior: `seq` é a trava (409 se mudou),
              `canDecide` é o papel, `pending` trava os dois durante a mutação. */}
          <NexusAiApproval
            title={p.lead_title}
            description={p.next_action}
            context={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {p.contact_name && <span>· {p.contact_name}</span>}
                {p.stage_name && (
                  <Badge variant="secondary" className="text-[11px]">
                    {p.stage_name}
                  </Badge>
                )}
                {/* Há quanto tempo espera é a informação que decide a ORDEM de
                    quem olha — por isso fica no contexto, não escondida. */}
                <span>
                  {t("proposta")} {quando(p.proposed_at, localeDaData)}
                </span>
              </span>
            }
            approveLabel={t("Aprovar")}
            dismissLabel={t("Ignorar")}
            approveAria={`${t("Aprovar")}: ${p.next_action}`}
            dismissAria={`${t("Ignorar")}: ${p.next_action}`}
            busy={pending}
            enabled={canDecide}
            onApprove={() => onDecidir(p.lead_id, "approve", p.seq)}
            onDismiss={() => onDecidir(p.lead_id, "dismiss", p.seq)}
          />
        </li>
      ))}
    </ul>
  );
}

function Historico({ itens }: { itens: DecisaoPassada[] }) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (itens.length === 0) {
    return (
      <Vazio
        titulo={t("Nenhuma decisão registrada ainda")}
        detalhe={t(
          "Aprovar e ignorar viram registro — os dois. Quando você decidir a primeira, ela fica aqui.",
        )}
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
              {d.decision === "approve" ? t("Aprovada") : t("Ignorada")}
            </Badge>
            <span className="text-sm font-medium">{d.lead_title}</span>
            <span className="text-xs text-muted-foreground">
              {t("por")} {d.decided_by ?? "—"} · {quando(d.decided_at, localeDaData)}
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
