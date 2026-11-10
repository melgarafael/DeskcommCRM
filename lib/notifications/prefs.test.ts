import { afterEach, describe, expect, it } from "vitest";

import { NOTIFY_UI_CATEGORIES, algumPushLigado, canalLigado, gravarCanal, lerPrefs, tiposCalados } from "./prefs";

describe("prefs de notificação", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("liga e desliga canal por categoria", () => {
    expect(canalLigado("lead_assigned", "in_app")).toBe(true);
    gravarCanal("lead_assigned", "in_app", false);
    expect(lerPrefs().lead_assigned.in_app).toBe(false);
    expect(canalLigado("lead_won", "push")).toBe(true);
  });

  it("o interruptor legado espelha 'algum push ligado', não o de mensagem", () => {
    gravarCanal("message", "push", false);
    expect(window.localStorage.getItem("alerts.enabled")).toBe("1");
    for (const cat of NOTIFY_UI_CATEGORIES) gravarCanal(cat, "push", false);
    expect(window.localStorage.getItem("alerts.enabled")).toBe("0");
    gravarCanal("lead_assigned", "push", true);
    expect(window.localStorage.getItem("alerts.enabled")).toBe("1");
  });

  it("os tipos calados são os de push desligado, e nenhum ligado encerra o aparelho", () => {
    gravarCanal("message", "push", false);
    gravarCanal("handoff", "push", false);
    expect(tiposCalados(lerPrefs())).toEqual(["message", "handoff"]);
    expect(algumPushLigado(lerPrefs())).toBe(true);
    for (const cat of NOTIFY_UI_CATEGORIES) gravarCanal(cat, "push", false);
    expect(algumPushLigado(lerPrefs())).toBe(false);
  });
});
