/**
 * A RECUSA DE NÚMERO INVÁLIDO VEM DA API, TRADUZIDA POR CHAVE (#4242, item 1).
 *
 * Numa organização fora do Brasil a API responde 422 `invalid_phone` com a frase
 * que ensina o formato do PAÍS ("Telefone deve estar em formato E.164 (+351 …)")
 * e a tela mostrava "Número inválido. Confira o DDD e tente de novo." — um DDD
 * que Portugal não tem, e o formato que resolveria ficava de fora.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ──────────────────────
 * - Voltar a frase fixa no ramo `invalid_phone`: o primeiro caso cai.
 * - Tirar a tradução de `mensagemDoTelefone`: o caso do espanhol cai.
 * - Trocar o exemplo do país por um literal: o caso do exemplo cai.
 */
import { describe, expect, it } from "vitest";

import { mensagemDeErro } from "@/components/contacts/TelefonesDaFicha";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { mensagemDoTelefone } from "@/lib/schemas/contacts";

const t = (texto: string) => texto;

describe("a tela mostra a frase da API para número inválido", () => {
  it("mensagem de organização fora do Brasil chega inteira à tela", () => {
    const frase = "Telefone deve estar em formato E.164 (+351 210 000 000)";
    const erro = new ApiError(422, "invalid_phone", undefined, "req-1", frase);

    // Sabotagem: devolver o texto fixo aqui é o defeito medido na tela.
    expect(mensagemDeErro(erro, t)).toBe(frase);
    expect(mensagemDeErro(erro, t)).not.toContain("DDD");
  });

  it("o resto dos códigos: frase do servidor primeiro, literal local como recurso", () => {
    // Lei da main (e884d7694): a mensagem do SERVIDOR vem primeiro, porque é ela
    // que conhece o país; o texto literal da tela só entra quando a resposta não
    // traz frase nenhuma (ou traz só o código).
    const emUsoComFrase = new ApiError(409, "phone_in_use", undefined, "req-2", "veio da API");
    expect(mensagemDeErro(emUsoComFrase, t)).toBe("veio da API");
    const emUsoSemFrase = new ApiError(409, "phone_in_use", undefined, "req-3");
    expect(mensagemDeErro(emUsoSemFrase, t)).toBe("Este número já está em outra ficha.");
    const inesperado = mensagemDeErro(new Error("boom"), t);
    expect(inesperado).toBe("Erro inesperado. Tente novamente.");
  });
});

describe("mensagemDoTelefone fala o idioma de quem opera e o formato do país", () => {
  it("em espanhol, a frase é a traduzida pela chave — não o português", () => {
    const frase = mensagemDoTelefone(perfilDoPais("PT"), "es");
    expect(frase).toMatch(/^El teléfono debe estar en formato E\.164 \(\+351/);
  });

  it("o {exemplo} é o do PAÍS da organização, e não um literal brasileiro", () => {
    const pt = perfilDoPais("PT");
    expect(mensagemDoTelefone(pt, "pt-BR")).toContain(pt.telefoneExemplo);

    const br = perfilDoPais("BR");
    // No Brasil a frase ensina as duas formas: o nacional derivado do E.164 do
    // perfil e o E.164 completo.
    expect(mensagemDoTelefone(br, "pt-BR")).toContain(br.telefoneExemplo.replace(/^\+55/, ""));
    expect(mensagemDoTelefone(br, "pt-BR")).toContain(br.telefoneExemplo);
  });

  it("as duas chaves têm espanhol no dicionário", () => {
    for (const chave of [
      "Telefone deve estar em formato E.164 ({exemplo})",
      "Telefone deve ter DDD + número (ex.: {exemplo}) ou o formato E.164 ({exemploE164})",
      "Telefone inválido. Informe DDD e número.",
    ]) {
      expect(traduzir(chave, "es")).not.toBe(chave);
    }
  });
});
