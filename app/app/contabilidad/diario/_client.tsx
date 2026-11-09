"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";

type JournalEntryLine = {
  id: string;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  label: string;
};

type JournalEntry = {
  id: string;
  number: string;
  date: string;
  journal_name: string;
  journal_id: string;
  entry_type: string;
  state: string;
  total_debit: number;
  lines?: JournalEntryLine[];
};

type Journal = {
  id: string;
  name: string;
  code: string;
};

export function Diario() {
  const queryClient = useQueryClient();
  const [filterState, setFilterState] = useState("");
  const [filterJournal, setFilterJournal] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build query params
  const params = new URLSearchParams();
  if (filterState) params.set("state", filterState);
  if (filterJournal) params.set("journal_id", filterJournal);
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  const qs = params.toString();

  const entries = useQuery({
    queryKey: ["journal-entries", filterState, filterJournal, dateFrom, dateTo],
    queryFn: () => apiClient.get<JournalEntry[]>(`/api/v1/finance/journal-entries${qs ? `?${qs}` : ""}`),
  });

  const journals = useQuery({
    queryKey: ["journals"],
    queryFn: () => apiClient.get<Journal[]>("/api/v1/finance/journals"),
  });

  // Fetch detail when expanding
  const detail = useQuery({
    queryKey: ["journal-entry-detail", expandedId],
    queryFn: () => apiClient.get<JournalEntry>(`/api/v1/finance/journal-entries/${expandedId}`),
    enabled: !!expandedId,
  });

  const postEntry = useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/finance/journal-entries/${id}/post`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    },
  });

  const fmt = (n: number) => n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Diario Contable</h1>
        <p className="text-sm text-text-muted">Asientos contables del periodo.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterState}
          onChange={(e) => setFilterState(e.target.value)}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">Todos los estados</option>
          <option value="draft">Borrador</option>
          <option value="posted">Publicado</option>
          <option value="cancelled">Cancelado</option>
        </select>

        <select
          value={filterJournal}
          onChange={(e) => setFilterJournal(e.target.value)}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">Todos los diarios</option>
          {journals.data?.map((j) => (
            <option key={j.id} value={j.id}>{j.name}</option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
          placeholder="Desde"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
          placeholder="Hasta"
        />
      </div>

      {entries.isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {entries.isError && <p className="text-sm text-red-500">Error al cargar datos</p>}

      {entries.data && entries.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2">Numero</th>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Diario</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {entries.data.map((entry) => (
                <>
                  <tr
                    key={entry.id}
                    className="cursor-pointer hover:bg-surface-secondary"
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  >
                    <td className="px-3 py-2 text-text-primary">{entry.number}</td>
                    <td className="px-3 py-2 text-text-muted">{entry.date}</td>
                    <td className="px-3 py-2 text-text-muted">{entry.journal_name}</td>
                    <td className="px-3 py-2 text-text-muted">{entry.entry_type}</td>
                    <td className="px-3 py-2">
                      <StateBadge state={entry.state} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-primary">{fmt(entry.total_debit)}</td>
                    <td className="px-3 py-2">
                      {entry.state === "draft" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            postEntry.mutate(entry.id);
                          }}
                          disabled={postEntry.isPending}
                          className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          Publicar
                        </button>
                      )}
                    </td>
                  </tr>
                  {/* Expanded detail lines */}
                  {expandedId === entry.id && (
                    <tr key={`${entry.id}-detail`}>
                      <td colSpan={7} className="bg-surface-secondary px-6 py-3">
                        {detail.isLoading && <p className="text-sm text-text-muted">Cargando lineas...</p>}
                        {detail.data?.lines && detail.data.lines.length > 0 ? (
                          <table className="w-full text-sm">
                            <thead className="text-left text-text-muted">
                              <tr>
                                <th className="px-2 py-1">Cuenta</th>
                                <th className="px-2 py-1">Etiqueta</th>
                                <th className="px-2 py-1 text-right">Debe</th>
                                <th className="px-2 py-1 text-right">Haber</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border-primary">
                              {detail.data.lines.map((line) => (
                                <tr key={line.id}>
                                  <td className="px-2 py-1 text-text-primary">
                                    {line.account_code} - {line.account_name}
                                  </td>
                                  <td className="px-2 py-1 text-text-muted">{line.label}</td>
                                  <td className="px-2 py-1 text-right font-mono text-text-primary">{fmt(line.debit)}</td>
                                  <td className="px-2 py-1 text-right font-mono text-text-primary">{fmt(line.credit)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          !detail.isLoading && <p className="text-sm text-text-muted">Sin lineas</p>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!entries.isLoading && entries.data?.length === 0 && (
        <p className="text-sm text-text-muted">No hay asientos para los filtros seleccionados.</p>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-700",
    posted: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-700",
  };
  const labels: Record<string, string> = {
    draft: "Borrador",
    posted: "Publicado",
    cancelled: "Cancelado",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${styles[state] ?? "bg-gray-100 text-gray-700"}`}>
      {labels[state] ?? state}
    </span>
  );
}
