// @vitest-environment node
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alvoNoIdioma,
  commitDaFoto,
  idiomaDaCaptura,
  pastaDaSaida,
  seletorNoIdioma,
  textoDaInterface,
  textoDoAlvo,
} from "./idioma";

afterEach(() => vi.unstubAllEnvs());
describe("idioma das fotografias reais", () => {
  it("mantém português como padrão e separa a pasta espanhola", () => {
    vi.stubEnv("CURSO_IDIOMA", "pt-BR");
    vi.stubEnv("CURSO_SAIDA", "");
    expect(idiomaDaCaptura()).toBe("pt-BR");
    expect(pastaDaSaida()).toMatch(/curso\/saida$/);
    expect(textoDaInterface("Assumir")).toBe("Assumir");
    vi.stubEnv("CURSO_IDIOMA", "es");
    expect(pastaDaSaida()).toMatch(/curso\/saida\/es$/);
    expect(textoDaInterface("Assumir")).toBe("Asumir");
  });
  it("recusa idiomas que o app não serve e commit sem proveniência", () => {
    vi.stubEnv("CURSO_IDIOMA", "en");
    expect(idiomaDaCaptura).toThrow(/a interface inglesa/);
    vi.stubEnv("CURSO_COMMIT_FOTOS", "main");
    expect(commitDaFoto).toThrow(/commit completo/);
    vi.stubEnv("CURSO_COMMIT_FOTOS", "1".repeat(40));
    expect(commitDaFoto()).toBe("1".repeat(40));
  });
  it("permite saída explícita sem alterar a pasta das contas da bancada", () => {
    vi.stubEnv("CURSO_SAIDA", "curso/saida/rodada-es");
    expect(pastaDaSaida()).toBe(path.resolve("curso/saida/rodada-es"));
  });
  it("traduz seletores visíveis e mantém ids, coordenadas e nomes próprios", () => {
    vi.stubEnv("CURSO_IDIOMA", "es");
    const alvo = {
      role: "button",
      nome: "Assumir",
      exato: true,
      dentro: { testid: "conversation-header" },
    };
    expect(alvoNoIdioma(alvo)).toEqual({ ...alvo, nome: "Asumir" });
    expect(alvo.nome).toBe("Assumir");
    expect(textoDoAlvo("Helena Prado")).toBe("Helena Prado");
    expect(textoDoAlvo("^Fila", true)).toBe("^Cola");
    expect(seletorNoIdioma('button[aria-label="Assumir"]:has-text("Fechar")')).toBe(
      'button[aria-label="Asumir"]:has-text("Cerrar")',
    );
    expect(seletorNoIdioma('[aria-label^="Responsável:"]')).toBe('[aria-label^="Responsable:"]');
    expect(seletorNoIdioma('[aria-label="Posição 1 na fila"]')).toBe(
      '[aria-label="Posición 1 en la cola"]',
    );
    expect(seletorNoIdioma('div:text-matches("^Meta do mês", "i")')).toBe(
      'div:text-matches("^Meta del mes", "i")',
    );
    expect(seletorNoIdioma("div:text-matches('^Trilha de auditoria')")).toBe(
      "div:text-matches('^Pista de auditoría')",
    );
    expect(seletorNoIdioma('[data-testid="assumir-conversa"]')).toBe(
      '[data-testid="assumir-conversa"]',
    );
  });
  it("encontra trechos de conversa traduzidos sem confundir rótulos da interface", () => {
    vi.stubEnv("CURSO_IDIOMA", "es");
    expect(seletorNoIdioma('div:has-text("Pode sim! Preciso levar algum exame?")')).toContain(
      "¿Necesito llevar algún examen?",
    );
    expect(seletorNoIdioma('button:has-text("Cancelar")')).toBe('button:has-text("Cancelar")');
    expect(textoDaInterface("/exame")).toBe("/sangre");
    expect(textoDaInterface("laudo")).toBe("informe");
  });

  it("preserva nomes da semente sem impedir a tradução dos botões dentro deles", () => {
    vi.stubEnv("CURSO_IDIOMA", "es");
    const alvo = {
      role: "button",
      nome: "Editar",
      dentro: { css: 'li:has-text("Profissional")', literal: true },
    };
    expect(alvoNoIdioma(alvo)).toEqual({ ...alvo, nome: "Editar" });
    expect(seletorNoIdioma(alvo.dentro.css)).toBe('li:has-text("Profesional")');
    expect(alvoNoIdioma({ ...alvo, nome: "Salvar" })).toEqual({ ...alvo, nome: "Guardar" });
  });
});
