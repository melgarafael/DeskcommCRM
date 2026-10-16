"use client";

import { useEffect, useState, useTransition } from "react";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Kanban, CircleNotch } from "@/lib/ui/icons";

interface EtapaOption {
  id: string;
  name: string;
  is_won?: boolean;
  is_lost?: boolean;
}

interface LeadSummary {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id?: string;
  funil_nome: string | null;
  etapa_nome: string | null;
  etapas_do_funil?: EtapaOption[];
}

interface Props {
  contactId?: string | null;
}

export function EtapaDoFunilHeader({ contactId }: Props) {
  const t = useT();
  const [lead, setLead] = useState<LeadSummary | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!contactId) {
      setLead(null);
      return;
    }

    let cancelado = false;
    setCarregando(true);

    apiClient
      .get<{ data: { leads: LeadSummary[] } }>(`/api/v1/contacts/${contactId}/crm-summary`)
      .then((res) => {
        if (cancelado) return;
        const primeiro = res.data?.leads?.[0] ?? null;
        setLead(primeiro);
      })
      .catch(() => {
        if (!cancelado) setLead(null);
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [contactId]);

  if (!contactId || carregando || !lead || !lead.stage_id) {
    return null;
  }

  const etapas = (lead.etapas_do_funil ?? []).filter((e) => !e.is_lost || e.id === lead.stage_id);
  if (etapas.length === 0) return null;

  async function handleMudarEtapa(novaEtapaId: string) {
    if (!lead || novaEtapaId === lead.stage_id) return;
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/leads/bulk", {
        action: "move",
        lead_ids: [lead.id],
        params: { stage_id: novaEtapaId },
      });
      const etapaObj = etapas.find((e) => e.id === novaEtapaId);
      setLead((ant) => (ant ? { ...ant, stage_id: novaEtapaId, etapa_nome: etapaObj?.name ?? ant.etapa_nome } : null));
      toast.success(t("Etapa do funil atualizada!"));
    } catch {
      toast.error(t("Não foi possível atualizar a etapa."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex items-center gap-1 shrink-0" data-testid="header-etapa-funil">
      <Select
        value={lead.stage_id}
        onValueChange={handleMudarEtapa}
        disabled={salvando}
      >
        <SelectTrigger className="h-8 max-w-[170px] sm:max-w-[210px] gap-1.5 px-2.5 text-xs font-medium border-border bg-background hover:bg-accent/50 shadow-xs">
          {salvando ? (
            <CircleNotch size={14} className="animate-spin text-primary shrink-0" aria-hidden />
          ) : (
            <Kanban size={14} className="text-primary shrink-0" aria-hidden />
          )}
          <span className="truncate text-left">
            <span className="text-muted-foreground hidden sm:inline">{t("Funil")}: </span>
            <span className="font-semibold text-foreground">{lead.etapa_nome ?? t("Etapa")}</span>
          </span>
        </SelectTrigger>
        <SelectContent align="end" className="text-xs">
          {etapas.map((etapa) => (
            <SelectItem key={etapa.id} value={etapa.id} className="text-xs">
              {etapa.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
