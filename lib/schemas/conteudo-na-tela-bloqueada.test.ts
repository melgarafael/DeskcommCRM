import { describe, expect, it } from "vitest";

import { conteudoNaTelaBloqueada, conteudoNaTelaBloqueadaWriteSchema } from "./settings";

describe("organizations.settings.notificacoes.conteudo_na_tela_bloqueada", () => {
  it.each([undefined, null, {}, { notificacoes: null }, { notificacoes: {} }, { notificacoes: { conteudo_na_tela_bloqueada: "xyz" } }])(
    "ausente ou inválido vira o padrão 'nome' (%j)",
    (settings) => {
      expect(conteudoNaTelaBloqueada(settings)).toBe("nome");
    },
  );

  it.each(["oculto", "nome", "nome_e_previa"] as const)("'%s' volta igual", (valor) => {
    expect(conteudoNaTelaBloqueada({ notificacoes: { conteudo_na_tela_bloqueada: valor } })).toBe(valor);
  });

  it.each(["texto", 42, [], true])("nunca lança com settings que não é objeto (%j)", (settings) => {
    expect(conteudoNaTelaBloqueada(settings)).toBe("nome");
  });

  it("a escrita é estrita: fora do enum é recusado", () => {
    expect(conteudoNaTelaBloqueadaWriteSchema.safeParse("oculto").success).toBe(true);
    expect(conteudoNaTelaBloqueadaWriteSchema.safeParse("tudo").success).toBe(false);
  });
});
