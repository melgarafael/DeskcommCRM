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

  /**
   * Quem desligou o Push de "Nova mensagem" ANTES de cada tipo ter o seu: o
   * código antigo gravava `message.push=false` e `alerts.enabled="0"`, e os
   * outros tipos ficavam `true` no storage. Depois da atualização, nada pode
   * voltar a tocar sozinho — nem a bandeja (`canalLigado` em `deliver.ts`) nem
   * a inscrição (`algumPushLigado` em `syncPushSubscription`).
   */
  const ANTIGO = {
    message: { in_app: true, push: false },
    lead_assigned: { in_app: true, push: true },
    lead_won: { in_app: true, push: true },
    lead_lost: { in_app: true, push: true },
    mention: { in_app: true, push: true },
    call_inbound: { in_app: true, push: true },
  };

  it("aparelho desligado antes da atualização segue sem nenhum Push", () => {
    window.localStorage.setItem("notify.prefs.v1", JSON.stringify(ANTIGO));
    window.localStorage.setItem("alerts.enabled", "0");
    for (const cat of NOTIFY_UI_CATEGORIES) expect(canalLigado(cat, "push"), cat).toBe(false);
    expect(algumPushLigado(lerPrefs())).toBe(false);
    // O In-app não é do aparelho: segue como estava.
    expect(canalLigado("lead_assigned", "in_app")).toBe(true);
  });

  it("controle: o mesmo storage com o aparelho ligado mantém os outros tipos", () => {
    window.localStorage.setItem("notify.prefs.v1", JSON.stringify(ANTIGO));
    window.localStorage.setItem("alerts.enabled", "1");
    expect(canalLigado("message", "push")).toBe(false);
    expect(canalLigado("lead_assigned", "push")).toBe(true);
  });

  it("religar um tipo depois disso liga só ele", () => {
    window.localStorage.setItem("notify.prefs.v1", JSON.stringify(ANTIGO));
    window.localStorage.setItem("alerts.enabled", "0");
    gravarCanal("lead_assigned", "push", true);
    expect(window.localStorage.getItem("alerts.enabled")).toBe("1");
    expect(tiposCalados(lerPrefs())).toEqual(NOTIFY_UI_CATEGORIES.filter((c) => c !== "lead_assigned"));
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
