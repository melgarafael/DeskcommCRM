"use client";
import { useCallback, useRef, useState } from "react";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Notice, Pick } from "./_ui";
import { useLoad } from "./_hooks";
export type ContactChoice = { id: string; name: string | null; phone_number?: string | null };
export function ContactPicker({
  selected,
  onSelect,
  initialContactId,
}: {
  selected: ContactChoice | null;
  onSelect: (value: ContactChoice | null) => void;
  initialContactId?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactChoice[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const version = useRef(0);
  const initialLoader = useCallback(async () => {
    const result = await apiClient.get<{ data: ContactChoice }>(
      `/api/v1/contacts/${initialContactId}`,
    );
    onSelect(result.data);
    return result.data;
  }, [initialContactId, onSelect]);
  const initial = useLoad(initialLoader, !!initialContactId);
  const search = async () => {
    const current = ++version.current;
    setPending(true);
    setError("");
    try {
      const result = await apiClient.get<{ data: ContactChoice[] }>(
        `/api/v1/contacts?search=${encodeURIComponent(query)}&limit=20`,
      );
      if (version.current === current) setResults(result.data);
    } catch {
      if (version.current === current)
        setError("Não foi possível buscar os contatos. Atualize a busca.");
    } finally {
      if (version.current === current) setPending(false);
    }
  };
  return (
    <div className="space-y-3">
      {selected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            Contato destinatário: <strong>{selected.name ?? "Sem nome"}</strong>
            {selected.phone_number ? ` · ${selected.phone_number}` : ""}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              onSelect(null);
              setResults(null);
            }}
          >
            Trocar contato
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="min-w-0 grow">
            <Field label="Contato destinatário no CRM">
              <Input
                value={query}
                required
                placeholder="Nome ou telefone do contato"
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
          </div>
          <Button variant="outline" disabled={pending || !query.trim()}>
            Buscar contato
          </Button>
        </form>
      )}
      {!selected && results && (
        <Pick
          label="Escolher contato destinatário"
          value=""
          options={results.map((value) => ({
            value: value.id,
            label: `${value.name ?? "Sem nome"}${value.phone_number ? ` · ${value.phone_number}` : ""}`,
          }))}
          onChange={(e) => onSelect(results.find((value) => value.id === e.target.value) ?? null)}
        />
      )}
      {results?.length === 0 && !selected && (
        <p className="text-sm">
          Nenhum contato encontrado. Cadastre o destinatário em Contatos para fazer o vínculo.
        </p>
      )}
      <Notice error={error || initial.error} loading={pending || initial.loading} />
    </div>
  );
}
