import { describe, expect, it } from "vitest";
import { Nicho, validarJornadas } from "./jornada";

const cena = { id: "chegada", titulo: "Chegada", cliente: "Pergunta", operacao: "Equipe atende", valor: "Contexto disponível", captura: "foto" };
const historia = { id: "consulta", titulo: "Consulta", empresa: "Empresa fictícia", contexto: "Exemplo", resultado: "Atendimento", tipo: "roteiro-demonstrativo", nota: "Dados fictícios", dependencias: "Canal configurado", montagem: [{ modulo: "inbox", licao: "ler", porque: "Ver a conversa" }], cenas: [cena] };
const nicho = { id: "clinicas", titulo: "Clínicas", resumo: "Atendimento", jornadas: [historia] };
const modulos = [{ id: "inbox", licoes: [{ id: "ler" }] }];
const capturas = { foto: { foto: "fotos/foto.png", destaques: [] } };

describe("contrato das jornadas", () => {
  it("aceita conteúdo válido e catálogo vazio durante a montagem", () => {
    expect(Nicho.parse(nicho).id).toBe("clinicas");
    expect(() => validarJornadas([nicho], modulos, capturas)).not.toThrow();
    expect(() => validarJornadas([], modulos, capturas)).not.toThrow();
  });
  it("recusa campos desconhecidos, ids inseguros e histórias sem cenas", () => {
    expect(Nicho.safeParse({ ...nicho, privado: "segredo" }).success).toBe(false);
    expect(Nicho.safeParse({ ...nicho, id: "clinicas.<script>" }).success).toBe(false);
    expect(Nicho.safeParse({ ...nicho, jornadas: [{ ...historia, cenas: [] }] }).success).toBe(false);
  });
  it("recusa ids repetidos em cada escopo", () => {
    expect(() => validarJornadas([nicho, nicho], modulos, capturas)).toThrow(/repetid/);
    expect(() => validarJornadas([{ ...nicho, jornadas: [historia, historia] }], modulos, capturas)).toThrow(/repetid/);
    expect(() => validarJornadas([{ ...nicho, jornadas: [{ ...historia, cenas: [cena, cena] }] }], modulos, capturas)).toThrow(/repetid/);
  });
  it("recusa referência de lição ausente", () => {
    expect(() => validarJornadas([nicho], [], capturas)).toThrow(/lição/);
    expect(() => validarJornadas([nicho], [{ id: "inbox", licoes: [] }], capturas)).toThrow(/lição/);
  });
  it("recusa foto ausente, URL externa e chave herdada", () => {
    expect(() => validarJornadas([nicho], modulos, {})).toThrow(/foto/);
    expect(() => validarJornadas([nicho], modulos, { foto: { foto: "https://example.com/foto.png" } })).toThrow(/foto/);
    expect(() => validarJornadas([{ ...nicho, jornadas: [{ ...historia, cenas: [{ ...cena, captura: "constructor" }] }] }], modulos, capturas)).toThrow(/foto/);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { Modulo, chaveDoPasso } from "./licao";
import { receitas, chaveDaCena } from "./receitas-jornadas";

describe("catálogo público de jornadas", () => {
  const pasta = path.join(process.cwd(), "curso");
  const arquivos = readdirSync(path.join(pasta, "demonstracoes")).filter((f) => f.endsWith(".json")).sort();
  const nichos = arquivos.map((f) => Nicho.parse(JSON.parse(readFileSync(path.join(pasta, "demonstracoes", f), "utf8"))));
  const licoes = readdirSync(path.join(pasta, "licoes")).filter((f) => f.endsWith(".json")).map((f) => Modulo.parse(JSON.parse(readFileSync(path.join(pasta, "licoes", f), "utf8"))));
  // A saída e as fotos são ignoradas pelo Git: o gate de unidade também roda no clone fresco.
  // Aqui verificamos a chave canônica do passo; o montador confere manifesto e arquivo físico.
  const fotos = Object.fromEntries(licoes.flatMap((m) => m.licoes.flatMap((l) => l.passos.map((p) => {
    const chave = chaveDoPasso(m.id, l.id, p.id);
    return [chave, { foto: `capturas/${chave}.jpg` }];
  }))));

  for (const r of receitas) for (const c of r.cenas) {
    const chave = chaveDaCena(r.jornada, c.id);
    fotos[chave] = { foto: `capturas/${chave}.jpg` };
  }

  it("cobre os dez nichos com três histórias e ao menos quatro cenas por história", () => {
    expect(nichos.map((n) => n.id).sort()).toEqual([
      "advocacia", "clinicas", "consorcio", "contabilidade", "e-commerce",
      "educacao", "imobiliarias", "infoprodutos", "seguros", "servicos",
    ]);
    for (const [i, n] of nichos.entries()) {
      expect(arquivos[i]).toBe(`${n.id}.json`);
      expect(n.jornadas).toHaveLength(3);
      for (const j of n.jornadas) expect(j.cenas.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("mantém ids de jornada únicos no catálogo inteiro e prefixados pelo nicho", () => {
    const ids = nichos.flatMap((n) => n.jornadas.map((j) => {
      expect(j.id.startsWith(`${n.id}-`)).toBe(true);
      return j.id;
    }));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("liga lições e chaves de captura a passos existentes do curso", () => {
    expect(() => validarJornadas(nichos, licoes, fotos)).not.toThrow();
  });

  it("declara o caráter demonstrativo e distingue fotos reais, personagens e prova do motor", () => {
    for (const n of nichos) for (const j of n.jornadas) {
      expect(j.tipo).toBe("roteiro-demonstrativo");
      expect(j.empresa).toContain("fictícia");
      expect(j.nota.toLowerCase()).toContain("telas reais");
      expect(j.nota).toMatch(/semeados|reconstituíd/);
      expect(j.nota).toMatch(/simulado/);
      expect(j.dependencias.length).toBeGreaterThan(80);
    }
  });
});

// Exerce o renderer estático com dados de teste, sem publicar uma história falsa.
describe("apresentação estática", () => {
  it("recupera hashes inválidos, monta links de lição e indexa histórias", async () => {
    document.body.innerHTML = '<main id="teste" tabindex="-1"></main>';
    const vista = document.getElementById("teste")!;
    const criar = new Function(readFileSync(path.join(process.cwd(), "curso/site/demonstracoes.js"), "utf8") + ";return window.criarDemonstracoes;")();
    const dados = { nichos: [nicho], modulos: [{ id: "inbox", titulo: "Inbox", licoes: [{ id: "ler", titulo: "Ler conversa" }] }], capturas };
    const demo = criar({ dados, vista, esc: (s: string) => s, figura: () => '<figure>Foto anotada</figure>', legenda: () => '<ol>Legenda</ol>' });
    expect(demo.reconhecer("m.inbox")).toBeNull();
    expect(demo.reconhecer("demo.clinicas.consulta.nao-existe")).toEqual({ tipo: "acao" });
    expect(demo.reconhecer("acao.clinicas.excesso")).toEqual({ tipo: "acao" });
    const r = demo.reconhecer("demo.clinicas.consulta.chegada");
    vista.innerHTML = demo.render(r);
    vista.scrollTop = 900;
    demo.posRender(r);
    expect(vista.scrollTop).toBe(0);
    expect(document.activeElement).toBe(vista);
    expect(vista.getAttribute('aria-labelledby')).toBe('demo-titulo-cena');
    expect(document.getElementById('demo-titulo-cena')?.textContent).toBe('Cena 1 de 1: Chegada');
    expect(demo.titulo(r)).toContain('Cena 1 de 1: Chegada');
    expect(vista.textContent).toContain("O cliente");
    expect(vista.textContent).toContain("Na operação");
    expect(vista.textContent).toContain("Por que ajuda");
    expect(vista.querySelector('a[aria-current="step"]')).not.toBeNull();
    expect(demo.entradasBusca().map((e: { titulo: string }) => e.titulo)).toEqual(["Clínicas", "Consulta"]);
    vista.innerHTML = demo.render(demo.reconhecer("montagem.clinicas.consulta"));
    expect(vista.querySelector('a[href="#l.inbox.ler"]')).not.toBeNull();
    // Fallback de tela cheia mantém um controle de saída mesmo após renderizar outra cena.
    vista.innerHTML = demo.render(r);
    const tela = vista.querySelector('[data-demo="tela"]') as HTMLButtonElement;
    tela.click();
    expect(document.body.classList.contains("demo-tela-cheia")).toBe(true);
    vista.innerHTML = demo.render(r); demo.posRender(r);
    expect(vista.querySelector('[data-demo="tela"]')?.textContent).toBe("Sair da tela cheia");
    demo.posRender(null);
    expect(vista.hasAttribute('aria-labelledby')).toBe(false);
    expect(document.body.classList.contains("demo-tela-cheia")).toBe(false);
    // Mensagens de clipboard são explícitas nos dois resultados.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    (vista.querySelector('[data-demo="copiar"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(vista.querySelector('[role="status"]')?.textContent).toBe("Link copiado.");
    writeText.mockRejectedValue(new Error("bloqueado"));
    (vista.querySelector('[data-demo="copiar"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(vista.querySelector('[role="status"]')?.textContent).toContain("Não foi possível copiar");
  });
});
