/**
 * UMA CHAVE, UMA TELA — e quem decide é o catálogo, não a tela.
 *
 * O DEC-009 mudou o LUGAR da chave do serviço externo de e-mail: ela saía de
 * "Credenciais" (`/admin/configuracao`) e passou a morar em "E-mail"
 * (`/admin/email`), ao lado do servidor próprio, porque "como o meu servidor
 * manda e-mail" é um assunto só e estava dividido em duas telas.
 *
 * Mudança de lugar tem um modo de falhar próprio, e é silencioso: a chave
 * aparecer nas DUAS. Duas telas escrevendo na mesma linha do banco, cada uma com
 * o seu formulário, é como nasce a divergência que ninguém percebe — uma ganha
 * a correção seguinte e a outra fica mostrando ao operador uma verdade que já
 * mudou.
 *
 * A defesa é estrutural: cada tela filtra pelo campo `telaDona` do catálogo, e
 * nenhuma delas cita nome de chave. Enquanto for assim, "aparecer em duas" não
 * é um descuido possível — seria preciso escrever a chave numa tela à mão, que
 * é exatamente o que o segundo caso proíbe.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";

const CREDENCIAIS = "app/admin/(protected)/configuracao/page.tsx";
const EMAIL = "app/admin/(protected)/email/page.tsx";

describe("uma chave da instalação mora numa tela só", () => {
  it("o catálogo atribui UMA tela a cada chave, e a da Resend é a de e-mail", () => {
    const porChave = new Map<string, string>();
    for (const d of CATALOGO_DA_INSTALACAO) {
      expect(porChave.has(d.chave), `chave repetida no catálogo: ${d.chave}`).toBe(false);
      porChave.set(d.chave, d.telaDona ?? "credenciais");
    }
    expect(porChave.get("RESEND_API_KEY")).toBe("email");
    expect(porChave.get("RESEND_FROM_EMAIL")).toBe("email");
    // O contato de suporte NÃO foi junto: ele não é sobre como o e-mail sai, é
    // sobre a quem o usuário escreve. Sem este caso, "mover o grupo e-mail
    // inteiro" passaria por conserto.
    expect(porChave.get("SUPPORT_EMAIL")).toBe("credenciais");
  });

  it("as duas telas filtram pelo catálogo — nenhuma cita nome de chave", () => {
    for (const tela of [CREDENCIAIS, EMAIL]) {
      const fonte = readFileSync(tela, "utf8");
      const semProsa = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const citadas = CATALOGO_DA_INSTALACAO.filter((d) => semProsa.includes(d.chave)).map(
        (d) => d.chave,
      );
      expect(
        citadas,
        `${tela} cita nome de chave no código. A tela tem de perguntar ao catálogo ` +
          "(`telaDona`); lista escrita à mão é como a mesma chave volta a aparecer em duas " +
          "telas sem ninguém ver.",
      ).toEqual([]);
      expect(
        semProsa.includes("telaDona"),
        `${tela} não filtra por \`telaDona\` — sem o filtro, a tela mostra o catálogo inteiro`,
      ).toBe(true);
    }
  });
});
