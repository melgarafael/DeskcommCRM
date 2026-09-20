import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JourneyGuide } from "@/components/shell/JourneyGuide";
import { destinationForPath, JOURNEYS } from "@/lib/navigation/journeys";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";
const state = vi.hoisted(() => ({ pathname: "/app/ai/agents/new", role: "admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false }, activeOrg: { role: state.role } }),
}));
afterEach(cleanup);

describe("orientation without permission bypass", () => {
  it("matches the deepest path without matching similarly named routes", () => {
    expect(destinationForPath("/app/ai/agents/new", NAV_CATALOG)?.href).toBe("/app/ai/agents");
    expect(destinationForPath("/app/contacts-other", NAV_CATALOG)).toBeUndefined();
  });
  it("keeps the guide closed and offers a return to the list for details", () => {
    state.role = "admin";
    state.pathname = "/app/ai/agents/new";
    const { container } = render(<JourneyGuide />);
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("navigation", { name: "Você está aqui" })).toHaveTextContent("Criar");
    expect(container.querySelector('a[href="/app/ai/agents"]')).toBeTruthy();
  });
  it("does not leak administrative destinations to an attendant", () => {
    state.role = "agent";
    state.pathname = "/app/inbox";
    const { container } = render(<JourneyGuide />);
    expect(container.querySelector('a[href="/app/connections"]')).toBeNull();
    expect(container.querySelector('a[href="/app/ai/agents"]')).toBeNull();
  });
  it("uses only registered destinations for every journey", () => {
    for (const journey of Object.values(JOURNEYS))
      for (const href of journey.steps)
        expect(
          NAV_CATALOG.some((item) => item.href === href),
          href,
        ).toBe(true);
  });
});
