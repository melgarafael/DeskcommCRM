import { describe, expect, it } from "vitest";

import { destinatariosDoAviso, type MembroCandidato } from "@/lib/agencia/avisos/destinatarios";
import { textoDoAviso } from "@/lib/agencia/avisos/texto";

/** Quem recebe e o que chega (docs/agencia/SPEC-avisos.md, A4–A6). */
const editor1: MembroCandidato = {
  id: "m1",
  user_id: "u1",
  situacao: "ativo",
  funcoes: [{ ativa: true, permissoes: ["tarefas.criar"] }],
};
const editor2: MembroCandidato = { ...editor1, id: "m2", user_id: "u2" };
const gerente: MembroCandidato = {
  id: "m3",
  user_id: "u3",
  situacao: "ativo",
  funcoes: [{ ativa: true, permissoes: ["avisos.gerais"] }],
};
const dono: MembroCandidato = { id: "m4", user_id: "dono", situacao: "ativo", funcoes: [] };
const desligado: MembroCandidato = { ...gerente, id: "m5", user_id: "u5", situacao: "desativado" };
const TODOS = [editor1, editor2, gerente, dono, desligado];

describe("destinatariosDoAviso", () => {
  it("tarefa com dois responsáveis avisa os dois", () => {
    expect(destinatariosDoAviso({ tipo: "membros", ids: ["m1", "m2"] }, TODOS, new Set()).sort()).toEqual(["m1", "m2"]);
  });

  it("aviso geral vai para quem tem avisos.gerais e para o dono", () => {
    expect(destinatariosDoAviso({ tipo: "gerais" }, TODOS, new Set(["dono"])).sort()).toEqual(["m3", "m4"]);
  });

  it("membro desativado não recebe nada", () => {
    expect(destinatariosDoAviso({ tipo: "membros", ids: ["m5"] }, TODOS, new Set())).toEqual([]);
    expect(destinatariosDoAviso({ tipo: "gerais" }, TODOS, new Set(["u5"]))).not.toContain("m5");
  });
});

describe("textoDoAviso", () => {
  it("um aviso leva título, corpo e link", () => {
    const t = textoDoAviso({ tipo: "tarefa_atribuida", titulos: ["Editar 10 vídeos"], corpo: "Cliente X", url: "https://a/x" });
    expect(t).toContain("Editar 10 vídeos");
    expect(t).toContain("Cliente X");
    expect(t).toContain("https://a/x");
  });

  it("vários avisos iguais viram uma mensagem com a lista", () => {
    const t = textoDoAviso({ tipo: "tarefa_atribuida", titulos: ["A", "B", "C"], url: "https://a/agencia" });
    expect(t).toContain("3 tarefas novas");
    expect(t).toContain("• A");
    expect(t).toContain("• C");
  });

  it("lista longa é cortada", () => {
    const titulos = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const t = textoDoAviso({ tipo: "prazo_hoje", titulos, url: "https://a/agencia" });
    expect(t).toContain("e mais 4");
    expect(t).not.toContain("T11");
  });
});
