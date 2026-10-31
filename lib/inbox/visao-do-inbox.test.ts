import { describe, expect, it } from "vitest";

import {
  filtrosDaVisao,
  hrefDaVisao,
  statusDaLista,
  visaoAtiva,
} from "@/lib/inbox/visao-do-inbox";

const qs = (texto: string) => new URLSearchParams(texto);

describe("visão do Inbox na URL (redesign kvgroup)", () => {
  it("lê cada visão do submenu", () => {
    expect(visaoAtiva(qs(""))).toEqual({ tipo: "todas" });
    expect(visaoAtiva(qs("filter=ai"))).toEqual({ tipo: "ia" });
    expect(visaoAtiva(qs("view=nao-lidas"))).toEqual({ tipo: "nao-lidas" });
    expect(visaoAtiva(qs("view=grupos"))).toEqual({ tipo: "grupos" });
    expect(visaoAtiva(qs("channel=abc"))).toEqual({ tipo: "canal", id: "abc" });
    expect(visaoAtiva(qs("tag=vip"))).toEqual({ tipo: "tag", nome: "vip" });
  });

  it("o link de uma visão troca só a visão: aba, status e conversa aberta ficam", () => {
    const atual = qs("filter=mine&status=fechadas&id=c1&view=grupos");
    const href = hrefDaVisao(atual, { tipo: "canal", id: "n2" });
    const destino = new URL(href, "http://x").searchParams;
    expect(destino.get("filter")).toBe("mine");
    expect(destino.get("status")).toBe("fechadas");
    expect(destino.get("id")).toBe("c1");
    expect(destino.get("channel")).toBe("n2");
    expect(destino.get("view")).toBeNull();
  });

  it("'Com agente de IA' é uma visão das abertas, e sair dela solta o filtro", () => {
    const ia = new URL(hrefDaVisao(qs("status=fechadas"), { tipo: "ia" }), "http://x").searchParams;
    expect(ia.get("filter")).toBe("ai");
    expect(ia.get("status")).toBeNull();
    const volta = new URL(hrefDaVisao(qs("filter=ai"), { tipo: "grupos" }), "http://x").searchParams;
    expect(volta.get("filter")).toBeNull();
    expect(volta.get("view")).toBe("grupos");
  });

  it("sem visão na URL, os filtros lembrados valem (null)", () => {
    expect(filtrosDaVisao(qs("filter=mine"))).toBeNull();
    expect(filtrosDaVisao(qs("view=nao-lidas"))).toEqual({
      onlyUnread: true,
      onlyGroups: false,
      channel_session_id: undefined,
      tag: undefined,
    });
  });

  it("os links antigos das abas Fechadas/Arquivadas caem no status certo", () => {
    expect(statusDaLista(qs(""))).toBe("abertas");
    expect(statusDaLista(qs("filter=closed"))).toBe("fechadas");
    expect(statusDaLista(qs("filter=archived"))).toBe("arquivadas");
    expect(statusDaLista(qs("status=arquivadas&filter=mine"))).toBe("arquivadas");
  });
});
