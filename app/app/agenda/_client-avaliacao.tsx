"use client";

import { AgendaAvaliacaoShell } from "@/components/avaliacao/AgendaAvaliacaoShell";

export function AvaliacaoAgendaClient({ timezone }: { timezone: string | null }) {
  return <AgendaAvaliacaoShell timezone={timezone} />;
}
