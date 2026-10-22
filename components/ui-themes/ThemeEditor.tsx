"use client";
import { randomId } from "@/lib/random-id";
import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { updateUiTheme, type UpdateUiThemeResult } from "@/app/actions/settings/updateUiTheme";
import {
  validateUiThemeOptions,
  type InstalledUiTheme,
  type UiOptionValues,
  type UiAreaContract,
} from "@/lib/ui-themes/contracts";
import { resolveUiTheme, resolveUiArea, type UiThemeSavedState, type UiThemeSelection } from "@/lib/ui-themes/resolve";
import type { UiThemeApplyInput } from "@/lib/ui-themes/apply-input";
import { registeredUiAreas } from "@/lib/ui-themes/areas";
import { PreviewFrame } from "./PreviewFrame";
import { UiThemeProvider } from "./Provider";
import { ThemePreview } from "./ThemePreview";

const errors: Record<Extract<UpdateUiThemeResult, { ok: false }>["error"], string> = {
  validation_failed: "Confira as opções do tema.",
  unauthenticated: "Entre novamente para aplicar o tema.",
  forbidden: "Sua sessão não pode alterar o tema desta organização.",
  mfa_required: "Confirme a verificação em duas etapas antes de aplicar.",
  catalog_changed: "Os temas instalados mudaram. Recarregue antes de aplicar.",
  revision_conflict: "Outra edição alterou o tema. Recarregue para revisar a versão atual.",
  db_error: "Não foi possível aplicar o tema. Sua edição continua aqui para tentar novamente.",
};
const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverWaiting = () => false;

export function ThemeEditor({
  catalog,
  saved,
  catalogHash,
  loadError,
  canWrite,
  areaCatalog = registeredUiAreas,
  scope = "organization",
  applyAction = updateUiTheme,
}: {
  catalog: readonly InstalledUiTheme[];
  saved: UiThemeSavedState | UiThemeSelection | null;
  catalogHash: string;
  loadError: string | null;
  canWrite: boolean;
  areaCatalog?: readonly UiAreaContract[];
  scope?: "organization" | "installation-default";
  applyAction?: (input: UiThemeApplyInput) => Promise<UpdateUiThemeResult>;
}) {
  const t = useT(),
    router = useRouter();
  const initialDefault = scope === "installation-default";
  // A native select can change before React has installed its handlers. Keep editing closed until hydration.
  const interactive = useSyncExternalStore(subscribeToHydration, clientReady, serverWaiting);
  const active = resolveUiTheme(catalog, saved);
  function initialValues() {
    return Object.fromEntries(
      catalog.map((entry) => {
        const previous = saved?.configurations[entry.package.id];
        return [
          entry.package.id,
          validateUiThemeOptions(
            entry.package,
            previous?.version === entry.package.optionsVersion ? previous.values : {},
          ).values,
        ];
      }),
    );
  }
  const [draftId, setDraftId] = useState(active.package.id);
  const [drafts, setDrafts] = useState<Record<string, UiOptionValues>>(initialValues);
  const [showPreview, setShowPreview] = useState(false);
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  const [narrow, setNarrow] = useState(false);
  const [previewArea, setPreviewArea] = useState(areaCatalog[0]?.id ?? "inbox");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const entry = catalog.find((item) => item.enabled && item.package.id === draftId);
  const values = entry ? (drafts[draftId] ?? {}) : {};
  const draftTheme = entry
    ? { package: entry.package, values, fallback: null, requestedId: draftId }
    : null;
  const customized =
    entry?.package.id !== "padrao" && draftTheme
      ? areaCatalog.filter((area) => !!resolveUiArea(draftTheme, area))
      : [];
  const incompatible =
    draftTheme &&
    areaCatalog.some(
      (area) => draftTheme.package.areas[area.id] && !resolveUiArea(draftTheme, area),
    );
  function change(key: string, value: string | number | boolean) {
    setDrafts((previous) => ({ ...previous, [draftId]: { ...previous[draftId], [key]: value } }));
    request.current = null;
    setError(null);
  }
  function cancel() {
    setDraftId(active.package.id);
    setDrafts(initialValues());
    setShowPreview(false);
    setError(null);
    request.current = null;
  }
  function restoreDefaults() {
    if (!entry) return;
    setDrafts((previous) => ({
      ...previous,
      [draftId]: validateUiThemeOptions(entry.package, {}).values,
    }));
    request.current = null;
    setError(null);
  }
  async function apply() {
    if (!entry || pending || loadError || !canWrite) return;
    setPending(true);
    setError(null);
    request.current ??= randomId();
    try {
      const result = await applyAction({
        themeId: draftId,
        installationId: entry.installationId,
        options: values,
        revision: saved?.revision ?? 0,
        requestId: request.current,
        catalogHash,
      });
      if (!result.ok) {
        setError(initialDefault && result.error === "forbidden"
          ? t("Somente administradores plenos da plataforma podem definir o tema inicial.")
          : t(errors[result.error]));
        return;
      }
      toast.success(initialDefault
        ? t("Tema inicial salvo para as próximas organizações.")
        : t("Tema aplicado à organização."));
      router.refresh();
    } catch {
      setError(t(errors.db_error));
    } finally {
      setPending(false);
    }
  }
  const selectClass = "h-10 rounded-md border border-border bg-bg px-3 text-sm text-text";
  return (
    <section
      aria-labelledby="ui-theme-heading"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
    >
      <header>
        <h2 id="ui-theme-heading" className="text-lg font-semibold">
          {initialDefault ? t("Tema inicial de novas organizações") : t("Tema da interface")}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {initialDefault ? t("Definido:") : t("Ativo:")} <strong>{active.package.title}</strong>.{" "}
          {initialDefault
            ? t("Novas organizações começam com este tema e suas opções. As organizações existentes mantêm suas escolhas e cada uma pode trocar seu próprio tema depois.")
            : t("A escolha vale para esta organização.")}
        </p>
      </header>
      {loadError ? (
        <p role="alert" className="text-sm text-error">
          {t("Não foi possível ler a configuração. Recarregue antes de editar o tema.")}
        </p>
      ) : null}
      {active.fallback ? (
        <p role="status" className="rounded-md bg-warning-bg p-3 text-sm">
          {active.fallback === "options_invalid"
            ? t(
                "Algumas opções salvas são inválidas. A interface usa os valores padrão do tema; revise as opções antes de aplicar.",
              )
            : t(
                "A configuração salva não pode ser usada nesta instalação. A interface está usando Padrão; suas opções foram preservadas. Escolha um tema e aplique para confirmar.",
              )}
        </p>
      ) : null}
      {!canWrite ? (
        <p className="text-sm text-text-muted">
          {initialDefault
            ? t("Somente administradores plenos da plataforma podem definir o tema inicial.")
            : t("Somente administradores autorizados podem aplicar um tema.")}
        </p>
      ) : null}
      <fieldset
        disabled={!interactive || pending || !!loadError || !canWrite}
        className="flex flex-col gap-4"
      >
        <label className="flex max-w-md flex-col gap-1.5 text-sm font-medium">
          {t("Tema em edição")}
          <select
            className={selectClass}
            value={draftId}
            onChange={(event) => {
              setDraftId(event.target.value);
              request.current = null;
              setError(null);
            }}
          >
            {catalog
              .filter((item) => item.enabled)
              .map((item) => (
                <option key={item.package.id} value={item.package.id}>
                  {item.package.title}
                </option>
              ))}
          </select>
        </label>
        {entry ? <p className="text-sm text-text-muted">{entry.package.description}</p> : null}
        <p className="text-xs text-text-muted">
          {customized.length
            ? `${t("Áreas personalizadas:")} ${customized.map((area) => t(area.title ?? "Área adicional")).join(", ")}. ${t("Outras páginas continuam na composição padrão.")}`
            : t("Composição padrão em todas as áreas.")}
        </p>
        {incompatible ? (
          <p role="status" className="text-sm text-warning">
            {t("Algumas áreas não são compatíveis com esta versão e usam a composição padrão.")}
          </p>
        ) : null}
        {entry?.package.options.map((option) => (
          <label key={option.key} className="flex max-w-lg flex-col gap-1.5 text-sm">
            <span className="font-medium">{option.label}</span>
            {option.type === "boolean" ? (
              <input
                type="checkbox"
                checked={values[option.key] === true}
                onChange={(event) => change(option.key, event.target.checked)}
                className="h-5 w-5 accent-accent"
              />
            ) : option.type === "enum" ? (
              <select
                className={selectClass}
                value={String(values[option.key])}
                onChange={(event) => change(option.key, event.target.value)}
              >
                {option.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={option.min}
                  max={option.max}
                  step={option.step}
                  value={Number(values[option.key])}
                  onChange={(event) => change(option.key, Number(event.target.value))}
                  className="min-w-0 flex-1 accent-accent"
                />
                <output>{String(values[option.key])}</output>
              </div>
            )}
            {option.description ? (
              <span className="text-xs text-text-muted">{option.description}</span>
            ) : null}
          </label>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowPreview((previous) => !previous)}
          >
            {showPreview ? t("Fechar prévia") : t("Visualizar prévia")}
          </Button>
          <Button type="button" onClick={apply} disabled={!entry || pending}>
            {pending ? t("Aplicando…") : initialDefault ? t("Salvar tema inicial") : t("Aplicar tema")}
          </Button>
          {entry && entry.package.options.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={restoreDefaults}
              title={t("Restaurar os valores iniciais no rascunho.")}
            >
              {t("Restaurar opções")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={cancel}>
            {t("Cancelar edição")}
          </Button>
        </div>
      </fieldset>
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-error">
          <span>{error}</span>
          <Button type="button" variant="outline" onClick={() => router.refresh()}>
            {t("Recarregar configuração")}
          </Button>
        </div>
      ) : null}
      {showPreview && entry ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t("Prévia visual · dados fictícios")}</p>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="theme-preview-area">
                {t("Área da prévia")}
              </label>
              <select
                id="theme-preview-area"
                className={selectClass}
                value={previewArea}
                onChange={(event) => setPreviewArea(event.target.value)}
              >
                {areaCatalog.map((area) => (
                  <option key={area.id} value={area.id}>
                    {t(area.title ?? area.id)}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="theme-preview-appearance">
                {t("Aparência da prévia")}
              </label>
              <select
                id="theme-preview-appearance"
                className={selectClass}
                value={appearance}
                onChange={(event) => setAppearance(event.target.value as "light" | "dark")}
              >
                <option value="light">{t("Claro")}</option>
                <option value="dark">{t("Escuro")}</option>
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={narrow}
                  onChange={(event) => setNarrow(event.target.checked)}
                />
                {t("Celular")}
              </label>
            </div>
          </div>
          <p className="text-xs text-text-muted">
            {t(
              "A prévia não envia mensagens nem altera a aparência ativa. Aplique para salvar sua escolha.",
            )}
          </p>
          <PreviewFrame
            appearance={appearance}
            title={t("Prévia do tema em edição")}
            narrow={narrow}
          >
            <UiThemeProvider
              theme={{ package: entry.package, values, fallback: null, requestedId: draftId }}
              previewAppearance={appearance}
            >
              <ThemePreview areaId={previewArea} />
            </UiThemeProvider>
          </PreviewFrame>
        </div>
      ) : null}
    </section>
  );
}
