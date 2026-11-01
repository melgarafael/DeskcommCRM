import { describe, expect, it } from "vitest";

import { blocosVisiveis } from "@/lib/ajuda/hub";
import type { Role } from "@/lib/auth/types";
import { combinarInterfaces, destinosDaInterface } from "@/lib/navigation/interface";

const basicos = ["/app/inbox", "/app/kanban", "/app/contacts"];
const equipe = "/app/team";
const casos = "/app/ai/cases";
const montagem = ["/app/ai/agents", "/app/ai/knowledge/sources"];
const etapas = "/app/settings/tenant/pipelines";
const conexoes = "/app/connections";
const instalacao = "/app/settings/atualizacao";

function blocos(role: Role, settings?: unknown, plataforma = false, suporte = false) {
  return blocosVisiveis(
    plataforma,
    destinosDaInterface(settings, plataforma && !suporte, role, [], []),
  );
}
function hrefs(value: ReturnType<typeof blocosVisiveis>) {
  return value.flatMap((bloco) => bloco.itens.map((item) => item.href)).sort();
}

describe("Ajuda respeita a mesma interface do menu", () => {
  it.each([
    ["viewer", [...basicos, equipe]],
    ["agent", [...basicos, equipe, casos]],
    ["manager", [...basicos, equipe, casos, ...montagem, etapas]],
    ["admin", [...basicos, equipe, casos, ...montagem, etapas, conexoes]],
  ] as const)("%s recebe só os atalhos permitidos pelo catálogo", (role, esperados) => {
    expect(hrefs(blocos(role))).toEqual([...esperados].sort());
  });

  it("a escolha da empresa e do vínculo continua sendo interseção", () => {
    const settings = combinarInterfaces(
      { preset: "completa", destinos: ["/app/ajuda", "/app/inbox", "/app/contacts"] },
      { preset: "completa", destinos: ["/app/ajuda", "/app/inbox", "/app/kanban"] },
    );
    expect(hrefs(blocos("agent", settings))).toEqual(["/app/inbox"]);
  });

  it("uma escolha explícita não reabre a configuração escondida para o manager", () => {
    expect(hrefs(blocos("manager", {
      preset: "completa", destinos: ["/app/ajuda", "/app/contacts"],
    }))).toEqual(["/app/contacts"]);
  });

  it("uma seleção sem atalhos da Ajuda é vazia legítima, sem bloco vazio", () => {
    expect(blocos("viewer", { preset: "completa", destinos: ["/app/ajuda"] })).toEqual([]);
  });

  it("o bloco de IA desaparece quando nenhum dos seus destinos é visível", () => {
    expect(blocos("viewer").map((bloco) => bloco.titulo)).toEqual([
      "Começar a usar", "Sua empresa",
    ]);
  });

  it("admin de tenant não ganha a porta da instalação", () => {
    expect(hrefs(blocos("admin"))).not.toContain(instalacao);
  });

  it("a porta de instalação preserva o gate próprio de plataforma", () => {
    expect(hrefs(blocos("viewer", undefined, true))).toContain(instalacao);
  });

  it("suporte usa o papel do vínculo para atalhos e mantém a leitura de instalação existente", () => {
    expect(hrefs(blocos("viewer", undefined, true, true))).toEqual([
      ...basicos, equipe, instalacao,
    ].sort());
  });
});
