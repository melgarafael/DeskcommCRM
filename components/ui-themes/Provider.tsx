"use client";
import { createContext, useContext, useId, type ReactNode } from "react";
import { padrao } from "@/ui-themes/padrao/definition";
import { cssDaExtensaoDeTema } from "@/lib/extensions/tema";
import { globalClassName, type ResolvedUiTheme } from "@/lib/ui-themes/resolve";

const context = createContext<ResolvedUiTheme>({
  package: padrao,
  values: {},
  fallback: null,
  requestedId: "padrao",
});
export function UiThemeProvider({
  theme,
  children,
  previewAppearance,
}: {
  theme: ResolvedUiTheme;
  children: ReactNode;
  previewAppearance?: "light" | "dark";
}) {
  const id = theme.package.id;
  const instance = useId().replace(/[^a-zA-Z0-9_-]/g, "_");
  // A preview of the active package must not restyle another instance of that same package.
  const marker = `[data-ui-theme-instance="${instance}"]`;
  // Active global tokens include native portals. Preview tokens remain local to their instance.
  const scope = previewAppearance ? marker : `body:has(${marker})`;
  const selectors = [
    [scope, "claro"],
    [`[data-theme="dark"] ${scope}`, "escuro"],
  ] as const;
  const tokens = theme.package.global?.tokens;
  const previewTokens =
    tokens && previewAppearance === "dark" ? { ...tokens, claro: tokens.escuro } : tokens;
  const css = cssDaExtensaoDeTema(previewTokens ?? null, selectors).css;
  return (
    <context.Provider value={theme}>
      <div
        data-ui-theme-root={id}
        data-ui-theme-instance={instance}
        data-ui-theme-fallback={theme.fallback ?? undefined}
        data-ui-theme-preview={previewAppearance ? "true" : undefined}
        data-theme={previewAppearance}
        className={globalClassName(theme)}
        style={{ display: "contents" }}
      >
        {css ? <style>{css}</style> : null}
        {children}
      </div>
    </context.Provider>
  );
}
export function useUiTheme() {
  return useContext(context);
}
