import { describe, expect, it } from "vitest";
import { lerModulos } from "@/lib/modules/config";
import { sidebarGroups, searchable, hubSections } from "@/lib/navigation/registry";
describe("módulo Academia por empresa", () => {
  it.each([null, undefined, {}, { modules: null }, { modules: { academia: "true" } }, { modules: { academia: false } }])("ausência ou valor inválido desliga: %j", (settings) => {
    expect(lerModulos(settings).academia).toBe(false);
  });
  it("liga somente com boolean true", () => expect(lerModulos({ modules: { academia: true } }).academia).toBe(true));
  it("off oculta de sidebar, hub e busca, inclusive para admin de plataforma", () => {
    expect(sidebarGroups(true,"admin").flatMap(g=>g.items).some(d=>d.href==="/app/academia")).toBe(false);
    expect(hubSections("crm",true,"admin").flatMap(g=>g.items).some(d=>d.href==="/app/academia")).toBe(false);
    expect(searchable(true,"admin").some(d=>d.href==="/app/academia")).toBe(false);
  });
  it("ativação aparece nas três projeções e respeita preferências do vínculo", () => {
    const modules={academia:true};
    expect(sidebarGroups(false,"viewer",undefined,modules).flatMap(g=>g.items).some(d=>d.href==="/app/academia")).toBe(true);
    expect(hubSections("crm",false,"viewer",undefined,modules).flatMap(g=>g.items).some(d=>d.href==="/app/academia")).toBe(true);
    expect(searchable(false,"viewer",undefined,modules).some(d=>d.href==="/app/academia")).toBe(true);
    expect(searchable(false,"viewer",{preset:"simplificada"},modules).some(d=>d.href==="/app/academia")).toBe(false);
  });
  it("configuração disponível somente ao administrador", () => {
    expect(searchable(false,"manager").some(d=>d.href==="/app/settings/modules")).toBe(false);
    expect(searchable(false,"admin").some(d=>d.href==="/app/settings/modules")).toBe(true);
  });
});
