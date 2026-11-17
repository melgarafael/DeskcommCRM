"use client";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { read, errorText } from "./_api";
import { useLoad } from "./_hooks";
import { CatalogTable, Notice, Panel, Pick, options } from "./_ui";
import type { AmigoOperation, Named } from "./_types";
export function AmigoCatalogs() {
  const t = useT();
  const catalogs = [
    ["places", t("Unidades")],
    ["doctors", t("Médicos")],
    ["doctors_available", t("Médicos disponíveis")],
    ["specialties", t("Especialidades")],
    ["events", t("Tipos de atendimento")],
    ["insurances", t("Convênios")],
    ["insurance_plans", t("Convênios por grupo")],
    ["insurance_products", t("Produtos de convênio")],
  ] as const;
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
      title={t("Catálogos da clínica")}
      description={t(
        "Consulte os recursos do Amigo e refine os filtros. Convênio, grupo e produto têm seleções próprias.",
      )}
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
            label={t("Catálogo")}
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
            label={t("Unidade do catálogo")}
            value={place}
            placeholder={t("Todas as unidades")}
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
            label={t("Médico do catálogo")}
            value={doctor}
            placeholder={t("Todos os médicos")}
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
            label={t("Atendimento do catálogo")}
            value={event}
            placeholder={t("Todos os atendimentos")}
            options={options(events.data)}
            disabled={!["places", "doctors_available", "insurance_plans"].includes(kind)}
            onChange={(e) => setEvent(e.target.value)}
          />
          <Pick
            label={t("Convênio do catálogo")}
            value={insurance}
            placeholder={t("Sem filtro de convênio")}
            options={options(insurances.data)}
            disabled={
              !["events", "specialties", "insurance_products", "doctors_available"].includes(kind)
            }
            onChange={(e) => setInsurance(e.target.value)}
          />
          {kind === "insurance_plans" && (
            <Pick
              label={t("Grupo de convênio")}
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
              {t("Somente recursos agendáveis")}
            </label>
          )}
          {kind === "doctors" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={toConfirm}
                onChange={(e) => setToConfirm(e.target.checked)}
              />
              {t("Médicos para confirmação")}
            </label>
          )}
        </fieldset>
        {kind === "places" && (
          <p className="text-sm text-muted-foreground">
            {t("Para filtrar unidades, selecione médico e atendimento juntos ou deixe ambos vazios.")}
          </p>
        )}
        <Button disabled={pending || invalid}>{t("Consultar catálogo")}</Button>
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
          <p className="text-sm">{t("Nenhuma especialidade para estes filtros.")}</p>
        ))}
    </Panel>
  );
}
