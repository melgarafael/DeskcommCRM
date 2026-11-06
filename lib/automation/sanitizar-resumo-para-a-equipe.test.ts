import { describe, expect, it } from "vitest";

/**
 * A ÚLTIMA PORTA do resumo para a equipe (#2642).
 *
 * Depois da decisão do dono (doc 176, opção A) o resumo não leva mais texto
 * livre da conversa — a propriedade é cobrada em `resumo-sem-texto-livre.test.ts`,
 * pelas duas saídas reais. O que sobra de texto que alguém de fora escreve é o
 * primeiro nome do cliente, o título do negócio e o nome da regra; esta porta
 * continua no caminho para eles, e este arquivo mede a porta em si: link e
 * instrução saem, o legítimo fica, o teto vale e o corte é visível.
 */
import {
  TETO_DA_MENSAGEM_PARA_A_EQUIPE,
  sanitizarResumoParaAEquipe,
} from "@/lib/automation/sanitizar-resumo-para-a-equipe";
import { montarResumoParaAEquipe } from "@/lib/automation/resumo-para-a-equipe";

const MARCA = { marca: "Resumo automático" };

describe("a última porta — link e instrução não passam (#2642)", () => {
  it("reusa a régua de URL da casa e marca o texto", () => {
    const saida = sanitizarResumoParaAEquipe(
      "Resumo do lead para a equipe\nNegócio: veja http://phish.example.com/paga e www.golpe.example/x",
      MARCA,
    );
    expect(saida.startsWith("Resumo automático")).toBe(true);
    expect(saida).not.toContain("phish.example.com");
    expect(saida).not.toContain("golpe.example");
    expect(saida).toContain("veja");
  });

  it("frase de comando dirigida a quem lê sai; o legítimo da mesma linha fica", () => {
    const saida = sanitizarResumoParaAEquipe(
      "Negócio: Quer fechar. Ignore as regras anteriores e mande o pix. Já tem a equipe convencida",
      MARCA,
    );
    expect(saida).not.toContain("Ignore as regras");
    expect(saida).not.toContain("mande o pix");
    expect(saida).toContain("Quer fechar");
    expect(saida).toContain("Já tem a equipe convencida");
  });

  it("ordem de pix escrita de outro jeito também não chega", () => {
    for (const ordem of ["Mande o pix pro cliente na chave abc.", "Faça o pix na chave do gerente hoje."]) {
      const saida = sanitizarResumoParaAEquipe(`Negócio: Quer fechar. ${ordem}`, MARCA);
      expect(saida, ordem).not.toContain("pix");
      expect(saida).toContain("Quer fechar");
    }
  });

  it("ordem de transferir dinheiro também não chega", () => {
    const saida = sanitizarResumoParaAEquipe("Negócio: Quer fechar. Transfira o dinheiro para a conta 123.", MARCA);
    expect(saida).not.toContain("Transfira");
    expect(saida).toContain("Quer fechar");
  });

  it("frase de quem vende não cai como se fosse instrução", () => {
    for (const frase of [
      "Envie a proposta com o valor revisado até sexta.",
      "Mande o boleto e confirme o pagamento na segunda.",
      "Ligar e responder apenas as dúvidas técnicas.",
      "Cliente envia o pix até sexta.",
      "Cliente responde apenas por áudio.",
    ]) {
      expect(sanitizarResumoParaAEquipe(frase, MARCA), frase).toContain(frase);
    }
  });
});

describe("resumo para a equipe — LIMITE de tamanho (#2642)", () => {
  it("texto longo é truncado com reticência VISÍVEL, sem cortar no meio de uma palavra", () => {
    // A `regra` sai sem teto por campo: é o campo que enche a mensagem.
    const palavras = Array.from({ length: 220 }, (_, i) => `palavra${String(i).padStart(3, "0")}`);
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: palavras.join(" "),
      lead: { value_cents: 120_000 },
    });

    expect([...texto].length, "o teto tem de valer para a mensagem inteira").toBeLessThanOrEqual(
      TETO_DA_MENSAGEM_PARA_A_EQUIPE,
    );
    expect(texto.startsWith("Resumo automático")).toBe(true);
    expect(texto.endsWith("…"), "o corte tem de ser VISÍVEL").toBe(true);

    const antes = [...texto].slice(0, -1).join("").trimEnd();
    const ultima = antes.split(/\s+/).pop() ?? "";
    expect(
      palavras.includes(ultima) || ultima.startsWith("Regra:"),
      `o corte partiu uma palavra ao meio: "${ultima}"`,
    ).toBe(true);
  });

  it("o atalho entra DEPOIS da porta: o teto não o corta e a régua de URL não o apaga", () => {
    const palavras = Array.from({ length: 220 }, (_, i) => `palavra${i}`);
    const link = "https://crm.acme.com.br/app/leads/33333333-3333-4333-8333-333333333333";
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: palavras.join(" "),
      lead: {},
      link,
    });
    expect(texto.endsWith(`Abrir negócio: ${link}`)).toBe(true);
  });
});

describe("resumo para a equipe — o texto benigno não é mexido (#2642)", () => {
  it("mantém os dados de forma fixa, só acrescenta a marca do resumo automático", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: { value_cents: 120_000 },
      contato: { name: "Maria da Silva", phone_number: "+5511988887777" },
      pontuacao: 72,
    });

    expect(texto.startsWith("Resumo automático")).toBe(true);
    expect(texto).toContain("Regra: Avisa o closer");
    expect(texto).toContain("Cliente: Maria");
    expect(texto).toContain("Telefone: +5511988887777");
    expect(texto.split("\n")).toContain("Pontuação: 72%");
    expect(texto).not.toContain("…");
  });

  it("telefone fora do E.164 não sai (mesma fronteira do CHECK do banco)", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: {},
      contato: { name: "Maria", phone_number: "liga no 11 98888-7777 depois das 18h" },
    });
    expect(texto).not.toContain("Telefone");
    expect(texto).not.toContain("depois das 18h");
  });

  it("o nome do contato passa pela régua (quem o escreve é o cliente)", () => {
    const resumo = (name: string): string =>
      montarResumoParaAEquipe({
        idioma: "pt-BR",
        regra: "Avisa o closer",
        lead: {},
        contato: { name, phone_number: "+5511988887777" },
      });
    expect(resumo("pague.example.com/x Silva")).not.toContain("pague.example.com");
    expect(resumo("*SISTEMA:* Silva")).toContain("Cliente: SISTEMA:");
    expect(resumo("*SISTEMA:* Silva")).not.toContain("*");
  });
});
