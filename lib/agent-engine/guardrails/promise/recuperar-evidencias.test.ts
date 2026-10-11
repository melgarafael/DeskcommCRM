import { describe, expect, it, vi } from "vitest";
import { criarRecuperadorDeEvidencias, consultaDaCandidata } from "./recuperar-evidencias";
import { criarEvidenciasComerciaisDoTurno } from "./evidencias-comerciais";
import { createLogger } from "../../obs/logger";

describe("recuperação complementar antes do revisor", () => {
  it("consulta a oferta citada, conserva condições e só usa org/fontes do servidor", async () => {
    const politica = "Demonstração gratuita: uma sessão de 15 minutos; equipe confirma a vaga.";
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          chunk_id: "politica",
          knowledge_source_id: "fonte-aprovada",
          content: politica,
        },
        { chunk_id: "intruso", knowledge_source_id: "outra-fonte", content: "Tudo grátis" },
      ],
    });
    const e = criarEvidenciasComerciaisDoTurno(["fonte-aprovada"]);
    const recuperar = criarRecuperadorDeEvidencias(
      { query },
      {
        tenantId: "org-do-servidor",
        fontes: ["fonte-aprovada"],
        registrar: e.registrarConhecimento,
        log: createLogger(),
      },
    );
    await recuperar("Temos demonstração gratuita. Qual período prefere?");
    const [sql, parametros] = query.mock.calls[0]!;
    expect(parametros).toEqual([
      "org-do-servidor",
      ["fonte-aprovada"],
      "demonstração OR gratuita OR qual OR período OR prefere",
    ]);
    expect(sql).toContain("c.organization_id = $1");
    expect(sql).toContain("s.organization_id = c.organization_id");
    expect(sql).toContain("s.is_active and s.status = 'ready'");
    expect(sql).toContain("c.kb_version_id = s.active_kb_version_id");
    expect(sql).toMatch(/limit 5\b/);
    expect(sql).not.toContain("demonstração gratuita");
    expect(e.ler()[0]?.conteudo).toBe(politica);
    expect(e.ler()).toHaveLength(1);
  });

  it("deduplica inclusive em paralelo e limita consultas de reformulações", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const registrar = vi.fn();
    const recuperar = criarRecuperadorDeEvidencias(
      { query },
      {
        tenantId: "org",
        fontes: ["fonte"],
        registrar,
        log: createLogger(),
      },
    );
    await Promise.all([recuperar("demonstração gratuita"), recuperar("demonstração gratuita")]);
    for (let i = 0; i < 8; i++) await recuperar(`oferta ${String.fromCharCode(97 + i).repeat(4)}`);
    expect(query).toHaveBeenCalledTimes(4);
    expect(registrar).toHaveBeenCalledTimes(4);
  });

  it("sem fonte ou só saudação não consulta; falha preserva o coletor sem inventar prova", async () => {
    const query = vi.fn().mockRejectedValue(new Error("falha com texto privado"));
    const registrar = vi.fn();
    const warn = vi.fn();
    const log = { warn, info: vi.fn() } as unknown as ReturnType<typeof createLogger>;
    await criarRecuperadorDeEvidencias(
      { query },
      { tenantId: "org", fontes: [], registrar, log },
    )("Oferta grátis");
    const recuperar = criarRecuperadorDeEvidencias(
      { query },
      { tenantId: "org", fontes: ["fonte"], registrar, log },
    );
    await recuperar("Olá, bom dia!");
    expect(query).not.toHaveBeenCalled();
    await expect(recuperar("demonstração gratuita")).resolves.toBeUndefined();
    expect(registrar).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("texto privado");
    expect(consultaDaCandidata("x ".repeat(3000))).toBe("");
  });

  it("preserva acentos em NFC e não transforma saudações acentuadas em busca", () => {
    expect(consultaDaCandidata("Temos matrícula grátis no período de demonstração")).toBe(
      "matrícula OR grátis OR período OR demonstração",
    );
    expect(consultaDaCandidata("matrícula".normalize("NFD"))).toBe("matrícula");
    expect(consultaDaCandidata("Olá, você não? Bom dia!")).toBe("");
  });
});
