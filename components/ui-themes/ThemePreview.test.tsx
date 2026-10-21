import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compatibleArea, validateUiThemeOptions } from "@/lib/ui-themes/contracts";
import { inboxArea } from "@/lib/ui-themes/areas";
import { exampleTheme } from "@/ui-themes/author-template/definition";
import { ThemePreview } from "./ThemePreview";
afterEach(cleanup);
describe("public author samples", () => {
  it("the copyable example uses the public contract and rejects unknown values", () => {
    expect(compatibleArea(exampleTheme.areas.inbox!, inboxArea)).toBe(true);
    expect(validateUiThemeOptions(exampleTheme, { "global.heading": "emphasis" }).valid).toBe(true);
    expect(validateUiThemeOptions(exampleTheme, { "global.heading": "url(external)" }).valid).toBe(
      false,
    );
  });
  it("pipeline displays native score presentation without fetching or mutating", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      render(<ThemePreview areaId="pipeline" />);
      expect(screen.getByText("72%")).toBeVisible();
      expect(fetch).not.toHaveBeenCalled();
      expect(document.querySelector("[inert]")).toBeTruthy();
    } finally {
      fetch.mockRestore();
    }
  });
  it("calendar uses the native history/grid with fictional data and no command callbacks", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      render(<ThemePreview areaId="calendar" />);
      expect(screen.getByTestId("historico-da-agenda")).toBeInTheDocument();
      expect(screen.getByTestId("grade-da-agenda")).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
      expect(document.querySelector("[inert]")).toBeTruthy();
    } finally {
      fetch.mockRestore();
    }
  });
  it("a new area without a sample has an explicit fallback", () => {
    render(<ThemePreview areaId="author-demo" />);
    expect(screen.getByText(/ainda não oferece uma amostra/)).toBeVisible();
  });
});
