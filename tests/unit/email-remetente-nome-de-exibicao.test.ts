/**
 * O NOME DE EXIBIÇÃO DO REMETENTE É SÓ NOME — nos dois transportes.
 *
 * Na RFC 5322 vírgula, dois-pontos, parênteses, colchetes, ponto e `@` dentro
 * do nome mudam a leitura do `From:`. O nome vem de campo de tela, e nomes
 * reais de empresa têm esses caracteres ("Silva, Lima Advogados").
 *
 * A medição é o nodemailer REAL (o mesmo do `lib/email/smtp.ts`), não um dublê:
 * o que vale é o `From:` que sai no fio e o remetente do envelope.
 */
import addressparser from "nodemailer/lib/addressparser";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";

import type { SmtpConfig } from "@/lib/email/config";
import { fromAddress } from "@/lib/email/resend";
import { formatFromAddress } from "@/lib/email/smtp";

const ENDERECO = "nao-responda@revenda.com.br";

const CONFIG: SmtpConfig = {
  host: "smtp.revenda.com.br",
  port: 465,
  security: "tls",
  username: ENDERECO,
  password: "segredo",
  fromEmail: ENDERECO,
  fromName: "",
  source: "environment",
};

const transporte = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "\n" });

async function noFio(from: string) {
  const info = await transporte.sendMail({ from, to: "cliente@exemplo.com", subject: "s", text: "t" });
  // Desdobra o cabeçalho (RFC 5322 §2.2.3) antes de ler linha a linha.
  const linhas = String(info.message).replace(/\n[ \t]+/g, " ").split("\n");
  const cabecalho = linhas.find((linha) => linha.startsWith("From:"));
  return {
    envelope: info.envelope.from,
    cabecalho,
    linhas,
    caixas: addressparser((cabecalho ?? "").slice("From:".length)),
  };
}

const NOMES_COM_ESPECIAIS = [
  "Silva, Lima Advogados",
  "contato@loja.com.br, Loja da Ana",
  "Ana (Loja)",
  "Loja: Ana",
  "Dr. Silva; Filhos",
  "Loja [Centro]",
  'Loja "da Ana"\\',
  "Loja da Ana\r\nReply-To: outra@exemplo.com",
];

describe.each([
  ["Resend", (nome?: string) => fromAddress(ENDERECO, nome)],
  ["SMTP", (nome?: string) => formatFromAddress(CONFIG, nome)],
])("remetente pelo %s", (_, montar) => {
  it.each(NOMES_COM_ESPECIAIS)("%j continua sendo UM remetente, com o endereço configurado", async (nome) => {
    const from = montar(nome);
    expect(from).not.toBeNull();
    const fio = await noFio(from as string);

    expect(fio.envelope).toBe(ENDERECO);
    expect(fio.caixas).toHaveLength(1);
    expect(fio.caixas[0]).not.toHaveProperty("group");
    expect(fio.caixas[0]).toMatchObject({ address: ENDERECO });
    expect(fio.linhas.filter((linha) => /^reply-to:/i.test(linha))).toEqual([]);
  });

  it("nome comum sai igual a antes, sem aspas", async () => {
    expect(montar("Loja da Ana")).toBe(`Loja da Ana <${ENDERECO}>`);
    const fio = await noFio(montar("Loja da Ana") as string);
    expect(fio.caixas).toEqual([{ name: "Loja da Ana", address: ENDERECO }]);
  });

  it("acento fica no nome; quem codifica é o transporte", async () => {
    expect(montar("Clínica São José")).toBe(`Clínica São José <${ENDERECO}>`);
    const fio = await noFio(montar("Clínica São José") as string);
    expect(fio.cabecalho).toBe(`From: =?UTF-8?Q?Cl=C3=ADnica_S=C3=A3o_Jos=C3=A9?= <${ENDERECO}>`);
  });

  it("vírgula no nome é preservada, entre aspas", () => {
    expect(montar("Silva, Lima Advogados")).toBe(`"Silva, Lima Advogados" <${ENDERECO}>`);
  });

  it("nome que esvazia na limpeza vira o endereço puro, sem lançar", () => {
    expect(montar("  \r\n ")).toBe(ENDERECO);
    expect(montar('<>"\\')).toBe(ENDERECO);
    expect(montar()).toBe(ENDERECO);
  });

  it("nome longo é cortado em 78 caracteres", () => {
    const from = montar("A".repeat(200)) as string;
    expect(from).toBe(`${"A".repeat(78)} <${ENDERECO}>`);
  });
});
