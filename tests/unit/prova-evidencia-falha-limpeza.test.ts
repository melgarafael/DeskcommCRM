// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { finalizarProvaComEvidencia } from "../e2e/helpers/finalizar-prova-com-evidencia";

describe("falha de evidência não impede cleanup nem vira verde", () => {
  it("attach rejeitado conserva o erro e executa limpeza e recibo final", async () => {
    const erro = new Error("attach_recusado");
    const info = { attach: vi.fn().mockRejectedValue(erro) };
    const ordem: string[] = [];
    const limpar = vi.fn(async () => { ordem.push("limpeza"); });
    const depois = vi.fn(async () => { ordem.push("recibo_final"); });
    await expect(finalizarProvaComEvidencia(
      async () => { ordem.push("anexo"); await info.attach("recibo-sintetico.json"); }, limpar, depois,
    )).rejects.toBe(erro);
    expect(ordem).toEqual(["anexo", "limpeza", "recibo_final"]);
    expect(limpar).toHaveBeenCalledTimes(1);
    expect(depois).toHaveBeenCalledTimes(1);
  });

  it("falha na escrita do recibo também não impede a limpeza", async () => {
    const erro = new Error("escrita_recusada");
    const limpar = vi.fn(async () => {});
    await expect(finalizarProvaComEvidencia(async () => { throw erro; }, limpar, async () => {})).rejects.toBe(erro);
    expect(limpar).toHaveBeenCalledTimes(1);
  });

  it("recibo final é tentado após cleanup rejeitado; primeira falha é preservada", async () => {
    const erro = new Error("limpeza_recusada");
    const depois = vi.fn(async () => { throw new Error("anexo_final_recusado"); });
    await expect(finalizarProvaComEvidencia(async () => {}, async () => { throw erro; }, depois)).rejects.toBe(erro);
    expect(depois).toHaveBeenCalledTimes(1);
  });

  it("todas as etapas confirmadas terminam sem erro", async () => {
    const ordem: string[] = [];
    await expect(finalizarProvaComEvidencia(
      async () => { ordem.push("antes"); }, async () => { ordem.push("limpeza"); }, async () => { ordem.push("depois"); },
    )).resolves.toBeUndefined();
    expect(ordem).toEqual(["antes", "limpeza", "depois"]);
  });
});
