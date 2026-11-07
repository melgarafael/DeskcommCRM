// @vitest-environment node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportarCapturas, lerIdsEsperados, type ManifestoExportavel } from "./exportacao";

const temporarias: string[] = [];
const raiz = process.cwd();
// JPEG 1×1 real, gerado uma vez com Pillow. Não é print de produto nem arquivo de texto disfarçado.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==", "base64");
// Segmento COM válido distingue os bytes das fotos da publicação anterior.
const JPEG_ANTERIOR = Buffer.concat([JPEG.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 5, 111, 108, 100]), JPEG.subarray(2)]);

function retrato(pasta: string): Record<string, string> {
  const arquivos: Record<string, string> = {};
  const visitar = (relativo: string) => {
    const arquivo = path.join(pasta, relativo);
    const info = fs.lstatSync(arquivo);
    if (info.isSymbolicLink()) arquivos[relativo] = `link:${fs.readlinkSync(arquivo)}`;
    else if (info.isDirectory()) {
      arquivos[relativo] = "diretório";
      for (const nome of fs.readdirSync(arquivo).sort()) visitar(path.join(relativo, nome));
    } else arquivos[relativo] = createHash("sha256").update(fs.readFileSync(arquivo)).digest("hex");
  };
  visitar("");
  return arquivos;
}

function fixture(anterior = false) {
  const pasta = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "curso-exportar-")));
  temporarias.push(pasta);
  const curso = path.join(pasta, "curso");
  const saida = path.join(pasta, "saida");
  const site = path.join(pasta, "site");
  const escrever = (arquivo: string, bytes: string | Buffer) => {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true }); fs.writeFileSync(arquivo, bytes);
  };
  const modulo = {
    id: "agenda", tela: "/app/agenda", titulo: "Agenda", resumo: "Os compromissos da clínica.",
    licoes: [{ id: "ver", titulo: "Ver a agenda", objetivo: "Reconhecer os compromissos.", papel: "admin", busca: [],
      passos: ["p1", "p2"].map((id) => ({ id, titulo: "Abrir agenda", texto: "Veja o compromisso.", rota: "/app/agenda", antes: [], destaques: [] })) }],
  };
  const nicho = {
    id: "clinicas", titulo: "Clínicas", resumo: "Demonstração da clínica.", jornadas: [{
      id: "clinicas-consulta", titulo: "Marcar consulta", empresa: "Clínica fictícia", contexto: "Um pedido de consulta.",
      resultado: "Consulta registrada.", tipo: "roteiro-demonstrativo", nota: "Dados fictícios.", dependencias: "Agenda.",
      montagem: [{ modulo: "agenda", licao: "ver", porque: "Mostra o compromisso." }],
      cenas: [{ id: "chegada", titulo: "Chegada", cliente: "Pede um horário.", operacao: "Abre a agenda.", valor: "Consulta registrada.", captura: "demo-clinicas-consulta--historia--chegada" }],
    }],
  };
  escrever(path.join(curso, "licoes/agenda.json"), JSON.stringify(modulo));
  escrever(path.join(curso, "demonstracoes/clinicas.json"), JSON.stringify(nicho));
  const ids = lerIdsEsperados(curso);
  const manifesto: ManifestoExportavel = {
    largura: 1, altura: 1, idioma: "es", commit_fonte: "a".repeat(40), versao: "1.89.0", gerado_em: "2026-10-27T12:00:00.123Z", falhas: [],
    capturas: Object.fromEntries(ids.map((id, i) => [id, {
      foto: `capturas/${id}.jpg`, idioma: "es" as const, commit_fonte: (i ? "a" : "b").repeat(40),
      versao: i ? "1.89.0" : "1.88.0", capturado_em: i ? "2026-10-27T12:00:00.123Z" : "2026-10-26",
      destaques: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.5, rotulo: " Zona del compromiso ", tipo: ["caixa", "seta", "numero"][i] as "caixa" | "seta" | "numero" }],
      clicar: i ? null : { x: 0, y: 0, w: 1, h: 1 },
    }])),
  };
  const salvar = () => escrever(path.join(saida, "capturas.json"), JSON.stringify(manifesto));
  salvar();
  for (const id of ids) escrever(path.join(saida, "capturas", `${id}.jpg`), JPEG);
  const canonico = path.join(site, "public/curso/index.html");
  escrever(canonico, `<html><script id="dados" type="application/json">${JSON.stringify({ modulos: [modulo], nichos: [nicho] })}</script></html>`);
  escrever(path.join(site, "conteudo/outro-guia.txt"), "trabalho de outra sessão\n");
  const destinoFotos = path.join(site, "public/curso/capturas/es");
  const destinoManifesto = path.join(site, "conteudo/curso/es/capturas.json");
  if (anterior) {
    const antigo = { ...manifesto, versao: "1.87.0", capturas: Object.fromEntries(ids.map((id) => [id, { ...manifesto.capturas[id]!, foto: `/curso/capturas/es/${id}.jpg` }])) };
    escrever(destinoManifesto, JSON.stringify(antigo));
    for (const id of ids) escrever(path.join(destinoFotos, `${id}.jpg`), JPEG_ANTERIOR);
  }
  const exportar = () => exportarCapturas({ idioma: "es", saida, site, curso });
  return { pasta, curso, saida, site, ids, manifesto, salvar, escrever, canonico, destinoFotos, destinoManifesto, exportar };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const pasta of temporarias.splice(0)) fs.rmSync(pasta, { recursive: true, force: true });
});

describe("exportação das capturas reais para o site", () => {
  it("copia o conjunto completo preservando bytes, metadados, medidas e o curso PT", () => {
    const f = fixture();
    const fonteAntes = retrato(f.saida);
    const ptAntes = fs.readFileSync(f.canonico);
    expect(f.ids).toEqual(["agenda--ver--p1", "agenda--ver--p2", "demo-clinicas-consulta--historia--chegada"]);
    expect(f.exportar()).toMatchObject({ idioma: "es", capturas: 3 });
    const exportado = JSON.parse(fs.readFileSync(f.destinoManifesto, "utf8"));
    expect(exportado).toEqual({ ...f.manifesto, capturas: Object.fromEntries(f.ids.map((id) => [id, { ...f.manifesto.capturas[id]!, foto: `/curso/capturas/es/${id}.jpg` }])) });
    expect(exportado.capturas[f.ids[0]!]!.commit_fonte).not.toBe(exportado.commit_fonte);
    for (const id of f.ids) expect(fs.readFileSync(path.join(f.destinoFotos, `${id}.jpg`))).toEqual(JPEG);
    expect(retrato(f.saida)).toEqual(fonteAntes);
    expect(fs.readFileSync(f.canonico)).toEqual(ptAntes);
    expect(fs.readFileSync(path.join(f.site, "conteudo/outro-guia.txt"), "utf8")).toBe("trabalho de outra sessão\n");
    const primeira = fs.readFileSync(f.destinoManifesto);
    f.exportar();
    expect(fs.readFileSync(f.destinoManifesto)).toEqual(primeira); // Sem data/versão fabricada na segunda execução.
    expect(fs.readdirSync(f.site).some((n) => n.startsWith(".curso-exportar-"))).toBe(false);
  });

  it.each(["faltante", "extra", "falha", "traversal", "idioma", "commit", "data", "medidas", "campo-secreto"])("recusa fonte inválida (%s) antes de alterar o destino", (caso) => {
    const f = fixture(true); const antes = retrato(f.site); const id = f.ids[0]!;
    if (caso === "faltante") delete f.manifesto.capturas[id];
    if (caso === "extra") f.manifesto.capturas["foto-extra"] = { ...f.manifesto.capturas[id]! };
    if (caso === "falha") f.manifesto.falhas.push(id);
    if (caso === "traversal") f.manifesto.capturas[id]!.foto = "capturas/../../fora.jpg";
    if (caso === "idioma") Object.assign(f.manifesto.capturas[id]!, { idioma: "pt-BR" });
    if (caso === "commit") f.manifesto.commit_fonte = "HEAD";
    if (caso === "data") f.manifesto.gerado_em = "2026-02-30T12:00:00Z";
    if (caso === "medidas") f.manifesto.capturas[id]!.clicar = { x: 1, y: 0, w: 1, h: 1 };
    if (caso === "campo-secreto") Object.assign(f.manifesto, { debug: "SEGREDO_INERTE_NAO_EXPORTAR" });
    f.salvar();
    expect(f.exportar).toThrow();
    expect(retrato(f.site)).toEqual(antes);
  });

  it.each(["ausente", "vazio", "texto", "symlink"])("recusa JPEG %s e conserva o destino", (caso) => {
    const f = fixture(true); const antes = retrato(f.site);
    const arquivo = path.join(f.saida, "capturas", `${f.ids[0]}.jpg`);
    fs.unlinkSync(arquivo);
    if (caso === "vazio") fs.writeFileSync(arquivo, "");
    if (caso === "texto") fs.writeFileSync(arquivo, "não é uma fotografia");
    if (caso === "symlink") {
      const fora = path.join(f.pasta, "fora.jpg"); fs.writeFileSync(fora, JPEG); fs.symlinkSync(fora, arquivo);
    }
    expect(f.exportar).toThrow(/JPEG|fotografia/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("recusa diretório de fotos da origem redirecionado por symlink", () => {
    const f = fixture(true); const antes = retrato(f.site);
    fs.renameSync(path.join(f.saida, "capturas"), path.join(f.pasta, "fotos-fora"));
    fs.symlinkSync(path.join(f.pasta, "fotos-fora"), path.join(f.saida, "capturas"), "dir");
    expect(f.exportar).toThrow(/link/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("não apaga arquivos alheios na pasta de fotos anterior", () => {
    const f = fixture(true);
    f.escrever(path.join(f.destinoFotos, "anotacao.txt"), "trabalho alheio");
    const antes = retrato(f.site);
    expect(f.exportar).toThrow(/sem vínculo/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("recusa destinos parciais ou com diretórios redirecionados", () => {
    const f = fixture(true);
    fs.unlinkSync(f.destinoManifesto);
    let antes = retrato(f.site);
    expect(f.exportar).toThrow(/parcial/);
    expect(retrato(f.site)).toEqual(antes);
    fs.rmSync(f.destinoFotos, { recursive: true });
    fs.rmdirSync(path.join(f.site, "conteudo/curso/es"));
    fs.mkdirSync(path.join(f.pasta, "destino-alheio"));
    fs.symlinkSync(path.join(f.pasta, "destino-alheio"), path.join(f.site, "conteudo/curso/es"), "dir");
    antes = retrato(f.site);
    expect(f.exportar).toThrow(/link/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("exige equivalência de IDs no curso canônico sem reescrevê-lo", () => {
    const f = fixture(true);
    const texto = fs.readFileSync(f.canonico, "utf8").replace('"id":"p2"', '"id":"passo-antigo"');
    fs.writeFileSync(f.canonico, texto);
    const antes = retrato(f.site);
    expect(f.exportar).toThrow(/catálogo do site difere/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("erro ao copiar a segunda foto não toca nos ativos ou manifesto anteriores", () => {
    const f = fixture(true); const antes = retrato(f.site); const fonteAntes = retrato(f.saida);
    const escrever = fs.writeFileSync; let copias = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation((arquivo, dados, opcoes) => {
      if (String(arquivo).includes(".curso-exportar-es-") && String(arquivo).endsWith(".jpg") && ++copias === 2) throw new Error("disco da fixture sem espaço");
      escrever(arquivo, dados, opcoes);
    });
    expect(f.exportar).toThrow(/falha ao preparar/);
    expect(retrato(f.site)).toEqual(antes);
    expect(retrato(f.saida)).toEqual(fonteAntes);
  });

  it.each([true, false])("falha na troca do manifesto conserva o destino (publicação anterior: %s)", (anterior) => {
    const f = fixture(anterior); const antes = retrato(f.site);
    const ligar = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((origem, destino) => {
      if (path.basename(String(origem)) === "novo-capturas.json") throw new Error("troca recusada na fixture");
      ligar(origem, destino);
    });
    expect(f.exportar).toThrow(/destino anterior restaurado/);
    expect(retrato(f.site)).toEqual(antes);
    if (anterior) for (const id of f.ids) expect(fs.readFileSync(path.join(f.destinoFotos, `${id}.jpg`))).toEqual(JPEG_ANTERIOR);
  });

  it("EEXIST antes de publicar o manifesto preserva o arquivo criado pela outra sessão e os backups", () => {
    const f = fixture(true);
    const antigo = fs.readFileSync(f.destinoManifesto);
    const alheio = Buffer.from("MANIFESTO DA OUTRA SESSÃO\n");
    const ligar = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((origem, destino) => {
      if (path.basename(String(origem)) === "novo-capturas.json") fs.writeFileSync(destino, alheio);
      ligar(origem, destino); // EEXIST real: não há mock do erro nem sobrescrita.
    });
    expect(f.exportar).toThrow(/publicação bloqueada/);
    expect(fs.readFileSync(f.destinoManifesto)).toEqual(alheio);
    const stage = path.join(f.site, fs.readdirSync(f.site).find((n) => n.startsWith(".curso-exportar-es-"))!);
    expect(fs.readFileSync(path.join(stage, "manifesto-anterior.json"))).toEqual(antigo);
    for (const id of f.ids) expect(fs.readFileSync(path.join(stage, "capturas-anteriores", `${id}.jpg`))).toEqual(JPEG_ANTERIOR);
    expect(fs.existsSync(path.join(f.site, ".curso-exportar-es.lock"))).toBe(true);
  });

  it("edição durante a tomada do rollback fica preservada no stage em vez de ser apagada", () => {
    const f = fixture(true);
    const alheio = Buffer.from("FOTO EDITADA PELA OUTRA SESSÃO DURANTE O ROLLBACK\n");
    const ligar = fs.linkSync; const renomear = fs.renameSync;
    vi.spyOn(fs, "linkSync").mockImplementation((origem, destino) => {
      if (path.basename(String(origem)) === "novo-capturas.json") throw new Error("troca recusada na fixture");
      ligar(origem, destino);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((origem, destino) => {
      renomear(origem, destino);
      if (path.basename(String(destino)) === "fotos-retiradas") fs.writeFileSync(path.join(String(destino), `${f.ids[0]}.jpg`), alheio);
    });
    expect(f.exportar).toThrow(/publicação bloqueada/);
    const stage = path.join(f.site, fs.readdirSync(f.site).find((n) => n.startsWith(".curso-exportar-es-"))!);
    expect(fs.readFileSync(path.join(stage, "fotos-retiradas", `${f.ids[0]}.jpg`))).toEqual(alheio);
    expect(fs.readFileSync(path.join(stage, "capturas-anteriores", `${f.ids[0]}.jpg`))).toEqual(JPEG_ANTERIOR);
    expect(fs.readFileSync(path.join(f.saida, "capturas", `${f.ids[0]}.jpg`))).toEqual(JPEG);
    expect(fs.existsSync(path.join(f.site, ".curso-exportar-es.lock"))).toBe(true);
  });

  it("confere o backup depois da tomada e conserva arquivo alheio que entrou nessa janela", () => {
    const f = fixture(true);
    const alheio = Buffer.from("ANOTAÇÃO CONCORRENTE\n");
    const renomear = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((origem, destino) => {
      renomear(origem, destino);
      if (path.basename(String(destino)) === "capturas-anteriores") fs.writeFileSync(path.join(String(destino), "anotacao-alheia.txt"), alheio);
    });
    expect(f.exportar).toThrow(/publicação bloqueada/);
    const stage = path.join(f.site, fs.readdirSync(f.site).find((n) => n.startsWith(".curso-exportar-es-"))!);
    expect(fs.readFileSync(path.join(stage, "capturas-anteriores/anotacao-alheia.txt"))).toEqual(alheio);
    expect(fs.existsSync(path.join(stage, "manifesto-anterior.json"))).toBe(true);
  });

  it("a restauração exclusiva também preserva manifesto criado por outra sessão", () => {
    const f = fixture(true);
    const alheio = Buffer.from("MANIFESTO CRIADO DURANTE A RESTAURAÇÃO\n");
    const ligar = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((origem, destino) => {
      if (path.basename(String(origem)) === "novo-capturas.json") throw new Error("troca recusada na fixture");
      if (path.basename(String(origem)) === "manifesto-anterior.json") fs.writeFileSync(destino, alheio);
      ligar(origem, destino);
    });
    expect(f.exportar).toThrow(/publicação bloqueada/);
    expect(fs.readFileSync(f.destinoManifesto)).toEqual(alheio);
    const stage = path.join(f.site, fs.readdirSync(f.site).find((n) => n.startsWith(".curso-exportar-es-"))!);
    expect(fs.existsSync(path.join(stage, "manifesto-anterior.json"))).toBe(true);
  });

  it("respeita reserva de outra sessão", () => {
    const f = fixture(true);
    f.escrever(path.join(f.site, ".curso-exportar-es.lock/anotacao.txt"), "outra sessão");
    const antes = retrato(f.site);
    expect(f.exportar).toThrow(/já reservada/);
    expect(retrato(f.site)).toEqual(antes);
  });

  it("CLI real oferece ajuda sem exigir arquivos e recusa idioma não suportado", () => {
    const f = fixture();
    const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(raiz, "node_modules/tsx/dist/cli.mjs"), path.join(raiz, "curso/exportar-capturas.ts"), ...args], {
      cwd: f.pasta, env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 20_000,
    });
    const ajuda = cli("--help"); expect(ajuda.status).toBe(0); expect(ajuda.stdout).toContain("--idioma es");
    const antes = retrato(f.site);
    const invalido = cli("--idioma", "pt-BR", "--saida", f.saida, "--site", f.site);
    expect(invalido.status).toBe(1); expect(invalido.stdout).toBe(""); expect(invalido.stderr).toContain("informe --idioma es");
    expect(retrato(f.site)).toEqual(antes);
  });
});
