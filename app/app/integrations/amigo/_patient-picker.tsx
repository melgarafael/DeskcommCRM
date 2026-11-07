"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, read } from "./_api";
import { Field, Notice, Pick } from "./_ui";
import type { Patient } from "./_types";
export function PatientPicker({
  selected,
  onSelect,
  disabled = false,
  contactId,
}: {
  selected: Patient | null;
  onSelect: (patient: Patient | null) => void;
  disabled?: boolean;
  contactId?: string;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("contact_cellphone");
  const [results, setResults] = useState<Patient[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const search = async () => {
    const version = ++generation.current;
    setPending(true);
    setError("");
    setResults(null);
    onSelect(null);
    try {
      const value = await read<Patient | Patient[]>(
        "patient_search",
        { [kind]: query.replace(/\D/g, "") },
        contactId,
      );
      if (version === generation.current) setResults(Array.isArray(value) ? value : [value]);
    } catch (e) {
      if (version === generation.current) setError(errorText(e));
    } finally {
      if (version === generation.current) setPending(false);
    }
  };
  return (
    <div className="space-y-3">
      <form
        className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Pick
          label="Buscar por"
          value={kind}
          placeholder=""
          disabled={disabled || pending}
          onChange={(e) => {
            setKind(e.target.value);
            setResults(null);
            onSelect(null);
          }}
          options={[
            { value: "contact_cellphone", label: "Telefone" },
            { value: "cpf", label: "CPF" },
          ]}
        />
        <Field label="CPF ou telefone">
          <Input
            value={query}
            inputMode="numeric"
            disabled={disabled || pending}
            onChange={(e) => {
              setQuery(e.target.value);
              setResults(null);
              onSelect(null);
            }}
            required
          />
        </Field>
        <Button disabled={disabled || pending || !query.replace(/\D/g, "")}>Buscar paciente</Button>
      </form>
      <Notice error={error} loading={pending} />
      {selected ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
          <p className="text-sm font-medium">Paciente selecionado: {selected.name}</p>
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => onSelect(null)}>
            Trocar paciente
          </Button>
        </div>
      ) : (
        results && (
          <>
            <p className="text-sm text-muted-foreground">Escolha quem receberá o atendimento.</p>
            {results.length === 0 && (
              <p className="text-sm">
                Nenhum paciente encontrado. Você pode cadastrá-lo na aba Pacientes.
              </p>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {results.map((patient) => (
                <div
                  key={patient.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4"
                >
                  <div>
                    <p className="font-medium">{patient.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {patient.cpf || "CPF não informado"} ·{" "}
                      {patient.contact_cellphone || "Telefone não informado"}
                      {patient.age != null && ` · ${patient.age} anos`}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Selecionar ${patient.name}`}
                    onClick={() => onSelect(patient)}
                  >
                    Selecionar
                  </Button>
                </div>
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}
