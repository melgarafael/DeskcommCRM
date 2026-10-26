import { describe, expect, it } from "vitest";

import { situacaoDoLink } from "@/lib/agencia/formulario/link";
import { cnpjValido, pendenciasDoEnvio, respostasSchema, respostasVazias, semSenhas, textoLegivel } from "@/lib/agencia/formulario/perguntas";

/** As regras puras da Fase 5 (docs/agencia/SPEC-cofre-e-formulario.md). */

function preenchido() {
  return respostasSchema.parse({
    empresas: [
      {
        nome: "Turbo Kids",
        cnpj: "11.222.333/0001-81",
        whatsapp: "(11) 99999-0000",
        email: "contato@turbokids.com.br",
        enderecos: ["Rua A, 10 — Centro"],
      },
    ],
    horarios: "Seg a Sex 8h às 18h",
    responsaveis: [{ nome: "Ana", cargo: "Marketing" }],
    produtos: "Brinquedos",
    acessos: {
      instagram: { login: "@turbokids", senha: "segredo-do-insta" },
      facebook: { pagina: "Turbo Kids", login: "tk@gmail.com", senha: "segredo-do-face" },
      tiktok: { naoTem: true },
    },
  });
}

describe("CNPJ", () => {
  it("confere os dígitos verificadores", () => {
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11222333000181")).toBe(true);
    expect(cnpjValido("11.222.333/0001-82")).toBe(false);
    expect(cnpjValido("00.000.000/0000-00")).toBe(false);
    expect(cnpjValido("123")).toBe(false);
  });
});

describe("rascunho e cópia legível nunca levam senha (F3/F4)", () => {
  it("semSenhas apaga só as senhas", () => {
    const r = semSenhas(preenchido());
    expect(r.acessos.instagram).toMatchObject({ login: "@turbokids", senha: "" });
    expect(r.acessos.facebook).toMatchObject({ pagina: "Turbo Kids", senha: "" });
    expect(JSON.stringify(r)).not.toContain("segredo");
  });

  it("a cópia do Drive tem o login e não tem a senha", () => {
    const t = textoLegivel(preenchido(), "Turbo Kids", new Date("2026-10-26T15:00:00Z"));
    expect(t).toContain("@turbokids");
    expect(t).toContain("TikTok: não tem");
    expect(t).not.toContain("segredo");
  });
});

describe("o que falta para enviar", () => {
  it("formulário completo pode ir", () => {
    expect(pendenciasDoEnvio(preenchido())).toEqual([]);
  });

  it("vazio lista o que falta, na ordem das perguntas", () => {
    const falta = pendenciasDoEnvio(respostasVazias());
    expect(falta[0]).toBe("o nome da empresa");
    expect(falta).toContain("os horários de atendimento");
    expect(falta).toContain("os produtos ou serviços");
  });

  it("CNPJ errado não passa", () => {
    const r = preenchido();
    r.empresas[0]!.cnpj = "11.222.333/0001-82";
    expect(pendenciasDoEnvio(r)).toContain("um CNPJ válido");
  });
});

describe("validade do link (F2)", () => {
  const agora = new Date("2026-10-26T12:00:00Z");
  it("aberto e dentro das 72 h vale; o resto diz por quê", () => {
    expect(situacaoDoLink({ situacao: "aberto", expira_em: "2026-10-27T12:00:00Z" }, agora)).toBe("valido");
    expect(situacaoDoLink({ situacao: "aberto", expira_em: "2026-10-26T11:59:00Z" }, agora)).toBe("expirado");
    expect(situacaoDoLink({ situacao: "enviado", expira_em: "2026-10-27T12:00:00Z" }, agora)).toBe("enviado");
    expect(situacaoDoLink({ situacao: "cancelado", expira_em: "2026-10-27T12:00:00Z" }, agora)).toBe("cancelado");
    expect(situacaoDoLink(null, agora)).toBe("inexistente");
  });
});
