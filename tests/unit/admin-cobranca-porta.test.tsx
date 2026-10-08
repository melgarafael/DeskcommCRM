/**
 * A PORTA DE /admin/cobranca (spec da cobrança §9, §13): a entrada do menu do
 * admin só existe com a chave ligada — desligada, o menu do dono segue igual.
 * A presença do href no menu é vigiada por `admin-navegacao-completude`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/dashboard" }));

import { AdminSidebar } from "@/components/admin/AdminSidebar";

afterEach(cleanup);

describe("menu do admin — Cobrança", () => {
  it("chave desligada: sem a entrada (controle: Tenants segue lá)", () => {
    render(<AdminSidebar userEmail="dono@x.test" modulosLigados={[]} />);
    expect(screen.queryByRole("link", { name: "Cobrança" })).toBeNull();
    expect(screen.getByRole("link", { name: "Tenants" })).toBeTruthy();
  });

  it("chave ligada: a entrada leva a /admin/cobranca", () => {
    render(<AdminSidebar userEmail="dono@x.test" modulosLigados={["cobranca"]} />);
    expect(screen.getByRole("link", { name: "Cobrança" }).getAttribute("href")).toBe("/admin/cobranca");
  });
});
