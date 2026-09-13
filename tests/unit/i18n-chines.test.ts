import { format } from "date-fns";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import chines from "@/lib/i18n/zh-CN.json";
import { localeDeData, tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO, normalizarIdioma } from "@/lib/i18n/idiomas";
import { IdiomaProvider, useT } from "@/lib/i18n/IdiomaProvider";
import { NAV_DESTINATIONS, NAV_GROUPS } from "@/lib/navigation/registry";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";

describe("interface em chinês simplificado", () => {
  it("traduz as datas e os motivos nos blocos reais da agenda", () => {
    const { unmount } = render(createElement(IdiomaProvider, {
      locale: "zh-CN",
      children: createElement(GradeDaAgenda, {
        visao: "dia", ancora: new Date(2026, 8, 14, 12), agora: new Date(2026, 8, 14, 8),
        pessoas: [], agendamentos: [],
        interacao: { horariosPorDia: {}, motivo: "erro", duracaoMin: 30, onMarcarEm: () => {} },
      }),
    }));
    const slot = screen.getByTestId("bloco-2026-09-14-09:00");
    expect(slot).toBeDisabled();
    expect(slot.getAttribute("aria-label")).toMatch(/9月14日/);
    expect(slot.getAttribute("aria-label")).not.toMatch(/\b(de|às|não|horários)\b/);
    expect(slot.getAttribute("title")).toMatch(/\p{Script=Han}/u);
    unmount();
  });

  it("formata valores em chinês sem mudar a moeda ou os centavos", () => {
    const cents = parseReaisToCents("1234.50");
    expect(cents).toBe(123450);
    expect(formatCentsBRL(cents!, "zh-CN")).toContain("1,234.50");
    expect(formatCentsBRL(cents!, "zh-CN")).toContain("R$");
    expect(formatCentsBRL(cents!)).toContain("1.234,50");
  });

  it("traduz o componente e atualiza o idioma do documento ao trocar", () => {
    function SaveButton() {
      const t = useT();
      return createElement("button", null, t("Salvar"));
    }
    const page = (locale: string) => createElement(IdiomaProvider, {
      locale, children: createElement(SaveButton),
    });
    const { rerender } = render(page("zh-CN"));
    expect(screen.getByRole("button")).toHaveTextContent("保存");
    expect(document.documentElement.lang).toBe("zh-CN");
    rerender(page("es"));
    expect(screen.getByRole("button")).toHaveTextContent("Guardar");
    expect(document.documentElement.lang).toBe("es");
  });

  it("cobre o dicionário sem traduções vazias", () => {
    expect(Object.keys(chines).sort()).toEqual(Object.keys(DICIONARIO).sort());
    for (const [source, translation] of Object.entries(chines)) {
      expect(translation.trim(), source).not.toBe("");
      expect(traduzir(source, "zh-CN"), source).toBe(translation);
    }
  });

  it("traduz os rótulos, descrições e grupos da navegação", () => {
    const labels = [
      ...NAV_DESTINATIONS.flatMap((item) => [item.label, item.description, ...(item.section ? [item.section] : [])]),
      ...NAV_GROUPS.flatMap((item) => [item.label, ...(item.hub ? [item.hub.label] : [])]),
      "Salvar", "Cancelar", "Excluir", "Conectado", "Configurações",
    ];
    const brands = ["Nuvemshop", "CRM", "Meta Ads", "Webhooks", "LGPD"];
    for (const label of labels.filter((label) => !brands.includes(label))) {
      expect(traduzir(label, "zh-CN"), label).toMatch(/\p{Script=Han}/u);
    }
  });

  it("aceita zh-CN e formata as datas em chinês", () => {
    expect(IDIOMA_PADRAO).toBe("pt-BR");
    expect(normalizarIdioma(undefined)).toBe("pt-BR");
    expect(normalizarIdioma("zh-CN")).toBe("zh-CN");
    expect(tagDeIdioma("zh-CN")).toBe("zh-CN");
    const date = new Date(2026, 8, 14, 13, 45);
    expect(format(date, "EEEE", { locale: localeDeData("zh-CN") })).toBe("星期一");
    for (const source of Object.keys(DICIONARIO).filter((key) => key.includes("'de'"))) {
      const pattern = traduzir(source, "zh-CN");
      const output = format(date, pattern, { locale: localeDeData("zh-CN") });
      expect(output, source).toMatch(/\p{Script=Han}/u);
      expect(output, source).not.toMatch(/\b(de|às|MMMM|yyyy)\b/);
    }
  });
});
