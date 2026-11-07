"use client";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { read, errorText } from "./_api";
import { useLoad } from "./_hooks";
import { CatalogTable, Notice, Panel, Pick, options } from "./_ui";
import type { AmigoOperation, Named } from "./_types";
const catalogs = [
  ["places", "Unidades"],
  ["doctors", "Médicos"],
  ["doctors_available", "Médicos disponíveis"],
  ["specialties", "Especialidades"],
  ["events", "Tipos de atendimento"],
  ["insurances", "Convênios"],
  ["insurance_plans", "Convênios por grupo"],
  ["insurance_products", "Produtos de convênio"],
] as const;
export function AmigoCatalogs() {
  const [kind, setKind] = useState<AmigoOperation>("places");
  const [place, setPlace] = useState("");
  const [doctor, setDoctor] = useState("");
  const [event, setEvent] = useState("");
  const [insurance, setInsurance] = useState("");
  const [group, setGroup] = useState("");
  const [schedulable, setSchedulable] = useState(true);
  const [toConfirm, setToConfirm] = useState(false);
  const [items, setItems] = useState<Named[] | null>(null);
  const [strings, setStrings] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const loadPlaces = useCallback(() => read<Named[]>("places"), []);
  const loadDoctors = useCallback(() => read<Named[]>("doctors"), []);
  const loadEvents = useCallback(
    () =>
      read<Named[]>("events", {
        ...(place ? { place_id: Number(place) } : {}),
        ...(doctor ? { user_id: Number(doctor) } : {}),
      }),
    [place, doctor],
  );
  const loadInsurances = useCallback(
    () =>
      read<Named[]>("insurances", {
        ...(place ? { place_id: Number(place) } : {}),
        ...(doctor ? { user_id: Number(doctor) } : {}),
      }),
    [place, doctor],
  );
  const places = useLoad(loadPlaces);
  const doctors = useLoad(loadDoctors);
  const events = useLoad(loadEvents);
  const insurances = useLoad(loadInsurances);
  const query = async () => {
    setPending(true);
    setError("");
    setItems(null);
    setStrings(null);
    const common = {
      ...(place ? { place_id: Number(place) } : {}),
      ...(doctor ? { user_id: Number(doctor) } : {}),
    };
    let input: Record<string, unknown> = {};
    switch (kind) {
      case "places":
        input = {
          ...(doctor && event ? { user_id: Number(doctor), event_id: Number(event) } : {}),
          only_schedulable: schedulable,
        };
        break;
      case "doctors":
        input = { to_confirm: toConfirm };
        break;
      case "doctors_available":
        input = {
          place_id: Number(place),
          ...(event ? { event_id: Number(event) } : {}),
          ...(insurance ? { insurance_id: Number(insurance) } : {}),
          only_schedulable: schedulable,
        };
        break;
      case "specialties":
        input = {
          ...(place ? { place_id: Number(place) } : {}),
          ...(insurance ? { insurance_id: Number(insurance) } : {}),
        };
        break;
      case "events":
        input = {
          ...common,
          ...(insurance ? { insurance_id: Number(insurance) } : {}),
          only_schedulable: schedulable,
        };
        break;
      case "insurances":
        input = common;
        break;
      case "insurance_plans":
        input = {
          ...common,
          insurance_group_id: Number(group),
          ...(event ? { event_id: Number(event) } : {}),
          only_schedulable: schedulable,
        };
        break;
      case "insurance_products":
        input = { insurance_id: Number(insurance) };
        break;
    }
    try {
      const value = await read<Named[] | string[]>(kind, input);
      if (kind === "specialties") setStrings(value as string[]);
      else setItems(value as Named[]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  const invalid =
    (kind === "insurance_plans" && !group) ||
    (kind === "insurance_products" && !insurance) ||
    (kind === "doctors_available" && !place) ||
    (kind === "places" && !!doctor !== !!event);
  return (
    <Panel
      title="Catálogos da clínica"
      description="Consulte os recursos do Amigo e refine os filtros. Convênio, grupo e produto têm seleções próprias."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void query();
        }}
      >
        <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Pick
            label="Catálogo"
            value={kind}
            placeholder=""
            options={catalogs.map(([value, label]) => ({ value, label }))}
            onChange={(e) => {
              setKind(e.target.value as AmigoOperation);
              setItems(null);
              setStrings(null);
              setError("");
            }}
          />
          <Pick
            label="Unidade do catálogo"
            value={place}
            placeholder="Todas as unidades"
            options={options(places.data)}
            disabled={["places", "doctors", "insurance_products"].includes(kind)}
            onChange={(e) => {
              setPlace(e.target.value);
              setEvent("");
              setInsurance("");
              setGroup("");
            }}
          />
          <Pick
            label="Médico do catálogo"
            value={doctor}
            placeholder="Todos os médicos"
            options={options(doctors.data)}
            disabled={[
              "doctors",
              "doctors_available",
              "specialties",
              "insurance_products",
            ].includes(kind)}
            onChange={(e) => {
              setDoctor(e.target.value);
              setEvent("");
              setInsurance("");
              setGroup("");
            }}
          />
          <Pick
            label="Atendimento do catálogo"
            value={event}
            placeholder="Todos os atendimentos"
            options={options(events.data)}
            disabled={!["places", "doctors_available", "insurance_plans"].includes(kind)}
            onChange={(e) => setEvent(e.target.value)}
          />
          <Pick
            label="Convênio do catálogo"
            value={insurance}
            placeholder="Sem filtro de convênio"
            options={options(insurances.data)}
            disabled={
              !["events", "specialties", "insurance_products", "doctors_available"].includes(kind)
            }
            onChange={(e) => setInsurance(e.target.value)}
          />
          {kind === "insurance_plans" && (
            <Pick
              label="Grupo de convênio"
              value={group}
              options={options(insurances.data)}
              required
              onChange={(e) => setGroup(e.target.value)}
            />
          )}
          {["places", "events", "doctors_available", "insurance_plans"].includes(kind) && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={schedulable}
                onChange={(e) => setSchedulable(e.target.checked)}
              />
              Somente recursos agendáveis
            </label>
          )}
          {kind === "doctors" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={toConfirm}
                onChange={(e) => setToConfirm(e.target.checked)}
              />
              Médicos para confirmação
            </label>
          )}
        </fieldset>
        {kind === "places" && (
          <p className="text-sm text-muted-foreground">
            Para filtrar unidades, selecione médico e atendimento juntos ou deixe ambos vazios.
          </p>
        )}
        <Button disabled={pending || invalid}>Consultar catálogo</Button>
      </form>
      <Notice
        error={error || places.error || doctors.error || events.error || insurances.error}
        loading={
          pending || places.loading || doctors.loading || events.loading || insurances.loading
        }
      />
      {items && <CatalogTable items={items} />}
      {strings &&
        (strings.length ? (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {strings.map((value) => (
              <li key={value} className="rounded-md border p-3">
                {value}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">Nenhuma especialidade para estes filtros.</p>
        ))}
    </Panel>
  );
}
