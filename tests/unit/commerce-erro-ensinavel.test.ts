/**
 * Erro de commerce vira resposta para o MODELO, não falha do job.
 * Regressão de 20/09/2026: `MagentoSoapError` caía em `noteRunError`, o job era marcado `falhou`
 * e reexecutado depois de o agente já ter avisado o cliente do erro.
 */
import { describe, expect, it } from "vitest";

import { CommerceCartError } from "@/lib/commerce/cart";
import { erroEnsinavelDeComercio } from "@/lib/commerce/erro-ensinavel";
import { PresentProductError } from "@/lib/commerce/present-product";
import { MagentoSoapError } from "@/lib/magento/soap";

describe("erroEnsinavelDeComercio", () => {
  it("CommerceCartError e PresentProductError mantêm code e message", () => {
    expect(erroEnsinavelDeComercio(new CommerceCartError("vazio", "carrinho_vazio"))).toEqual({
      ok: false,
      error: { code: "carrinho_vazio", message: "vazio" },
    });
    expect(erroEnsinavelDeComercio(new PresentProductError("sem estoque", "produto_sem_estoque"))).toEqual({
      ok: false,
      error: { code: "produto_sem_estoque", message: "sem estoque" },
    });
  });

  it("fault da loja vira loja_recusou com a mensagem da própria loja", () => {
    const r = erroEnsinavelDeComercio(new MagentoSoapError("Este produto está sem estoque.\nEste produto está sem estoque.", "soap_fault"));
    expect(r?.error.code).toBe("loja_recusou");
    expect(r?.error.message).toContain("Este produto está sem estoque. Este produto está sem estoque.");
  });

  it("rede/timeout vira loja_indisponivel e manda NÃO afirmar que a operação foi feita", () => {
    const r = erroEnsinavelDeComercio(new MagentoSoapError("aborted", "network_error"));
    expect(r?.error.code).toBe("loja_indisponivel");
    expect(r?.error.message).toContain("não diga que a operação foi feita");
  });

  it("erro que NÃO é de commerce continua indo para noteRunError (null)", () => {
    expect(erroEnsinavelDeComercio(new Error("banco fora"))).toBeNull();
    expect(erroEnsinavelDeComercio("string solta")).toBeNull();
  });
});
