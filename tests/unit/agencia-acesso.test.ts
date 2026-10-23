import { describe, expect, it } from "vitest";

import { decidirAcessoDaAgencia } from "@/lib/agencia/acesso";
import { entradasPermitidas, MENU_DA_AGENCIA } from "@/lib/agencia/menu";
import {
  PERMISSOES_DA_AGENCIA,
  PERMISSOES_EM_USO,
  somarPermissoes,
  todasAsPermissoes,
} from "@/lib/agencia/permissoes";

/**
 * Quem entra na área da agência (docs/agencia/SPEC-equipe.md, critérios 1, 2 e 6).
 */
describe("decidirAcessoDaAgencia", () => {
  it("módulo desligado responde como se a área não existisse, até para quem não está logado", () => {
    expect(decidirAcessoDaAgencia({ moduloLigado: false, logado: false, escopoDeAdmin: null }).tipo).toBe(
      "modulo_desligado",
    );
    expect(decidirAcessoDaAgencia({ moduloLigado: false, logado: true, escopoDeAdmin: "full" }).tipo).toBe(
      "modulo_desligado",
    );
  });

  it("sem login, manda entrar", () => {
    expect(decidirAcessoDaAgencia({ moduloLigado: true, logado: false, escopoDeAdmin: null }).tipo).toBe("sem_login");
  });

  it("platform admin full é dono: todas as permissões", () => {
    const d = decidirAcessoDaAgencia({ moduloLigado: true, logado: true, escopoDeAdmin: "full" });
    expect(d.tipo).toBe("liberado");
    if (d.tipo !== "liberado") return;
    expect(d.ehDono).toBe(true);
    expect([...d.permissoes].sort()).toEqual([...PERMISSOES_DA_AGENCIA].sort());
  });

  it("support_readonly não é dono da agência", () => {
    expect(decidirAcessoDaAgencia({ moduloLigado: true, logado: true, escopoDeAdmin: "support_readonly" }).tipo).toBe(
      "sem_acesso",
    );
  });

  it("logado sem vínculo nenhum não entra", () => {
    expect(decidirAcessoDaAgencia({ moduloLigado: true, logado: true, escopoDeAdmin: null }).tipo).toBe("sem_acesso");
  });

  it("membro ativo entra com a soma das funções ativas, e não é dono", () => {
    const d = decidirAcessoDaAgencia({
      moduloLigado: true,
      logado: true,
      escopoDeAdmin: null,
      membro: {
        situacao: "ativo",
        funcoes: [
          { ativa: true, permissoes: ["tarefas.criar"] },
          { ativa: false, permissoes: ["equipe.gerenciar"] },
        ],
      },
    });
    expect(d.tipo).toBe("liberado");
    if (d.tipo !== "liberado") return;
    expect(d.ehDono).toBe(false);
    expect([...d.permissoes]).toEqual(["tarefas.criar"]);
  });

  it("membro convidado ou desativado não entra", () => {
    for (const situacao of ["convidado", "desativado"]) {
      const d = decidirAcessoDaAgencia({
        moduloLigado: true,
        logado: true,
        escopoDeAdmin: null,
        membro: { situacao, funcoes: [{ ativa: true, permissoes: ["equipe.gerenciar"] }] },
      });
      expect(d.tipo).toBe("sem_acesso");
    }
  });

  it("dono que também tem linha de membro continua com tudo", () => {
    const d = decidirAcessoDaAgencia({
      moduloLigado: true,
      logado: true,
      escopoDeAdmin: "full",
      membro: { situacao: "desativado", funcoes: [] },
    });
    expect(d.tipo === "liberado" && d.ehDono).toBe(true);
  });
});

describe("somarPermissoes", () => {
  it("é a união das funções ativas", () => {
    const soma = somarPermissoes([
      { ativa: true, permissoes: ["tarefas.criar"] },
      { ativa: true, permissoes: ["tarefas.criar", "equipe.gerenciar"] },
    ]);
    expect([...soma].sort()).toEqual(["equipe.gerenciar", "tarefas.criar"]);
  });

  it("função desativada não conta", () => {
    const soma = somarPermissoes([{ ativa: false, permissoes: ["equipe.gerenciar"] }]);
    expect(soma.size).toBe(0);
  });

  it("item fora do vocabulário é ignorado, nunca concedido", () => {
    const soma = somarPermissoes([{ ativa: true, permissoes: ["tudo", "admin", "tarefas.criar"] }]);
    expect([...soma]).toEqual(["tarefas.criar"]);
  });
});

describe("menu da agência", () => {
  it("só mostra a entrada a quem tem a permissão que ela exige", () => {
    const semNada = entradasPermitidas(new Set());
    const comTudo = entradasPermitidas(todasAsPermissoes());
    expect(comTudo.length).toBe(MENU_DA_AGENCIA.length);
    for (const e of MENU_DA_AGENCIA) {
      expect(semNada.some((x) => x.href === e.href)).toBe(!e.exige);
    }
  });

  it("toda permissão em uso pertence ao vocabulário", () => {
    for (const p of PERMISSOES_EM_USO) expect(PERMISSOES_DA_AGENCIA).toContain(p);
  });
});
