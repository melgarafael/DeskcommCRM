// @vitest-environment node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Captura } from "./capturar";

const raiz = process.cwd();
const temporarias: string[] = [];
const primeira = "demo-clinicas-primeira-consulta--historia--chegada";
const acao = "demo-clinicas-primeira-consulta--historia--acao";
const foraDoRecorte = "demo-seguros-renovacao--historia--acao";
const selecionadas = [primeira, "demo-clinicas-primeira-consulta--historia--qualificacao", acao, "demo-clinicas-primeira-consulta--historia--continuidade"];
const falhasDasLicoes = ["inbox/erro-de-captura: falha anterior", "api-tokens: revogação pendente"];
type Manifesto = { largura: number; altura: number; capturas: Record<string, Captura>; falhas?: string[] };
const lerManifesto = (arquivo: string): Manifesto => JSON.parse(readFileSync(arquivo, "utf8"));

function fixture() {
  const pasta = realpathSync(mkdtempSync(path.join(tmpdir(), "curso-manifesto-")));
  temporarias.push(pasta);
  // Executa os CLIs e templates reais em outra árvore. Nunca aponta a saída para saida/ real.
  cpSync(path.join(raiz, "curso"), path.join(pasta, "curso"), {
    recursive: true,
    filter: (arquivo) => arquivo !== path.join(raiz, "curso/saida") && !arquivo.endsWith(".test.ts"),
  });
  symlinkSync(path.join(raiz, "lib"), path.join(pasta, "lib"), "dir");
  symlinkSync(path.join(raiz, "components"), path.join(pasta, "components"), "dir");
  symlinkSync(path.join(raiz, "node_modules"), path.join(pasta, "node_modules"), "dir");
  writeFileSync(path.join(pasta, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [`${raiz}/*`] } } }));
  const saida = path.join(pasta, "curso/saida");
  mkdirSync(path.join(saida, "capturas"), { recursive: true });
  const manifesto: Manifesto = { largura: 1440, altura: 900, capturas: {} };
  const inserir = (chave: string) => {
    const foto = `capturas/${chave}.jpg`;
    manifesto.capturas[chave] = { foto, clicar: null, destaques: [], versao: "1.0.0", capturado_em: "2026-01-01T00:00:00.000Z" };
    // Arquivo inerte para exercitar a guarda de existência; não é prova visual nem foto do app.
    writeFileSync(path.join(saida, foto), "arquivo anterior da fixture local");
  };
  for (const nome of readdirSync(path.join(pasta, "curso/licoes"))) {
    const m = JSON.parse(readFileSync(path.join(pasta, "curso/licoes", nome), "utf8"));
    for (const l of m.licoes) for (const p of l.passos) inserir(`${m.id}--${l.id}--${p.id}`);
  }
  for (const nome of readdirSync(path.join(pasta, "curso/demonstracoes"))) {
    const n = JSON.parse(readFileSync(path.join(pasta, "curso/demonstracoes", nome), "utf8"));
    for (const j of n.jornadas) for (const c of j.cenas) inserir(c.captura);
  }
  const arquivo = path.join(saida, "capturas.json");
  const salvar = (m: Manifesto) => writeFileSync(arquivo, JSON.stringify(m));
  salvar(manifesto); // Legado: sem campo falhas.
  const cli = (nome: string, ...args: string[]) => spawnSync(process.execPath, [path.join(raiz, "node_modules/tsx/dist/cli.mjs"), path.join(pasta, "curso", nome), ...args], {
    cwd: pasta, encoding: "utf8", timeout: 20_000,
    // Não herda credenciais, NODE_OPTIONS, dotenv ou configuração da bancada.
    env: { PATH: process.env.PATH, NODE_ENV: "test", CURSO_BASE: "/curso/", CURSO_URL: "http://127.0.0.1:1", CURSO_VERSAO_FOTOS: "2.0.0", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "fixture-sem-credencial" },
  });
  return { pasta, saida, arquivo, manifesto, salvar, cli };
}

afterEach(() => { for (const pasta of temporarias.splice(0)) rmSync(pasta, { recursive: true, force: true }); });

describe("recaptura de jornadas com manifesto anterior", () => {
  it("o CLI persiste todo o nicho antes de falhar por contas ausentes, conservando fotos e falhas anteriores", () => {
    const f = fixture();
    f.manifesto.falhas = [...falhasDasLicoes, foraDoRecorte];
    f.salvar(f.manifesto);
    const fotoAnterior = readFileSync(path.join(f.saida, f.manifesto.capturas[acao]!.foto));
    const resultado = f.cli("capturar-jornadas.ts", "clinicas");
    expect(resultado.error).toBeUndefined();
    expect(resultado.status).toBe(1);
    const depois = lerManifesto(f.arquivo);
    expect(depois.falhas).toEqual([...falhasDasLicoes, foraDoRecorte, ...selecionadas,
      "demo-clinicas-remarcar-sessao--historia--chegada", "demo-clinicas-remarcar-sessao--historia--qualificacao",
      "demo-clinicas-remarcar-sessao--historia--acao", "demo-clinicas-remarcar-sessao--historia--continuidade",
      "demo-clinicas-duvida-preparo--historia--chegada", "demo-clinicas-duvida-preparo--historia--qualificacao",
      "demo-clinicas-duvida-preparo--historia--acao", "demo-clinicas-duvida-preparo--historia--continuidade"]);
    expect(depois.falhas).toHaveLength(15); // 12 cenas selecionadas + três falhas já existentes.
    expect(depois.capturas).toEqual(f.manifesto.capturas);
    expect(readFileSync(path.join(f.saida, f.manifesto.capturas[acao]!.foto))).toEqual(fotoAnterior);
    expect(resultado.stderr).not.toMatch(/ENOENT|fixture-sem-credencial|contas\.json/);
  });

  it("falha do CLI invalida a montagem seguinte, mesmo com a foto e entrada antigas presentes", () => {
    const f = fixture();
    const antes = f.cli("montar.ts");
    expect(antes.status).toBe(0); // Também comprova compatibilidade legada sem falhas.
    const indiceAnterior = readFileSync(path.join(f.saida, "index.html"));
    const captura = f.cli("capturar-jornadas.ts", "clinicas-primeira-consulta");
    expect(captura.status).toBe(1);
    const montagem = f.cli("montar.ts");
    expect(montagem.status).toBe(1);
    expect(montagem.stderr).toMatch(/pendente.*demo-clinicas-primeira-consulta/s);
    expect(readFileSync(path.join(f.saida, "index.html"))).toEqual(indiceAnterior);
    // O recorte sem módulos exigidos pela clínica continua utilizável e omite a jornada pendente.
    const parcial = f.cli("montar.ts", "inbox");
    expect(parcial.status).toBe(0);
    const html = readFileSync(path.join(f.saida, "index.html"), "utf8");
    const dados = JSON.parse(html.match(/<script[^>]+id="dados"[^>]*>(.*?)<\/script>/s)![1]!);
    expect(dados.nichos.flatMap((n: { jornadas: { id: string }[] }) => n.jornadas).map((j: { id: string }) => j.id)).not.toContain("clinicas-primeira-consulta");
    expect(dados.capturas).not.toHaveProperty(acao);
    // A jornada omitida também pode ter falhado na primeira captura, sem entrada anterior.
    const semEntradaAnterior = lerManifesto(f.arquivo);
    delete semEntradaAnterior.capturas[acao]; f.salvar(semEntradaAnterior);
    const semJornada = f.cli("montar.ts", "inbox");
    expect(semJornada.status).toBe(0);
  });

  it.each(falhasDasLicoes)("a montagem mantém a recusa herdada: %s", (falha) => {
    const f = fixture();
    f.manifesto.falhas = [falha]; f.salvar(f.manifesto);
    writeFileSync(path.join(f.saida, "index.html"), "índice anterior");
    const montagem = f.cli("montar.ts");
    expect(montagem.status).toBe(1);
    expect(montagem.stderr).toMatch(/falha nos módulos selecionados/);
    expect(readFileSync(path.join(f.saida, "index.html"), "utf8")).toBe("índice anterior");
  });

  it("a montagem recusa chave bruta pendente com foto anterior e preserva o recorte não afetado", () => {
    const f = fixture();
    const chave = "agenda--conhecendo-a-agenda--p1";
    expect(f.manifesto.capturas[chave]).toBeDefined();
    const foto = path.join(f.saida, f.manifesto.capturas[chave]!.foto);
    const fotoAnterior = readFileSync(foto);
    expect(f.cli("montar.ts", "agenda").status).toBe(0);
    const indiceAnterior = readFileSync(path.join(f.saida, "index.html"));
    f.manifesto.falhas = [chave]; f.salvar(f.manifesto);
    const montagem = f.cli("montar.ts", "agenda");
    expect(montagem.status).toBe(1);
    expect(montagem.stderr).toMatch(/capturas com falha nos módulos selecionados: agenda/);
    expect(readFileSync(foto)).toEqual(fotoAnterior);
    expect(readFileSync(path.join(f.saida, "index.html"))).toEqual(indiceAnterior);
    const outroRecorte = f.cli("montar.ts", "inbox");
    expect(outroRecorte.status).toBe(0);
    const html = readFileSync(path.join(f.saida, "index.html"), "utf8");
    const dados = JSON.parse(html.match(/<script[^>]+id="dados"[^>]*>(.*?)<\/script>/s)![1]!);
    expect(dados.modulos.map((m: { id: string }) => m.id)).toEqual(["inbox"]);
    expect(dados.capturas).not.toHaveProperty(chave);
    expect(lerManifesto(f.arquivo).falhas).toEqual([chave]);
  });

  it("só libera a cena concluída; a falha seguinte bloqueia a montagem até a recaptura terminar", async () => {
    const f = fixture();
    f.manifesto.falhas = [foraDoRecorte]; f.salvar(f.manifesto);
    const { abrirManifestoDaRodada } = await import("./capturar-jornadas");
    const registrar = abrirManifestoDaRodada(f.arquivo, selecionadas);
    const nova = { ...f.manifesto.capturas[primeira]!, versao: "2.0.0", capturado_em: "2026-10-26T18:00:00.000Z" };
    await registrar(primeira, async () => {
      // A operação real de fotografia só começa depois da invalidação persistida.
      expect(lerManifesto(f.arquivo).falhas).toEqual([foraDoRecorte, ...selecionadas]);
      writeFileSync(path.join(f.saida, nova.foto), "nova foto concluída da fixture");
      return nova;
    });
    const depois = lerManifesto(f.arquivo);
    expect(depois.capturas[primeira]).toEqual(nova);
    expect(depois.falhas).toEqual([foraDoRecorte, ...selecionadas.slice(1)]);
    expect(depois.capturas[acao]).toEqual(f.manifesto.capturas[acao]);
    for (const etapa of ["medição", "screenshot", "metadados"]) {
      await expect(registrar(acao, async () => { throw new Error(`falha local de ${etapa}`); })).rejects.toThrow(etapa);
      expect(lerManifesto(f.arquivo)).toEqual(depois);
    }
    writeFileSync(path.join(f.saida, "index.html"), "índice anterior à falha da segunda cena");
    expect(f.cli("montar.ts").status).toBe(1);
    expect(readFileSync(path.join(f.saida, "index.html"), "utf8")).toBe("índice anterior à falha da segunda cena");
    for (const chave of selecionadas.slice(1)) await registrar(chave, async () => ({ ...f.manifesto.capturas[chave]!, versao: "2.0.0" }));
    expect(lerManifesto(f.arquivo).falhas).toEqual([foraDoRecorte]);
    // O recorte publica só a jornada concluída, sem ignorar pendência de outra história.
    const clinicas = JSON.parse(readFileSync(path.join(f.pasta, "curso/demonstracoes/clinicas.json"), "utf8"));
    const historia = clinicas.jornadas.find((j: { id: string }) => j.id === "clinicas-primeira-consulta");
    const montagem = f.cli("montar.ts", ...historia.montagem.map((r: { modulo: string }) => r.modulo));
    expect(montagem.status).toBe(0);
    // Uma recaptura não apaga falhas de captura/revogação das lições fora dela.
    f.salvar({ ...lerManifesto(f.arquivo), falhas: [...falhasDasLicoes, foraDoRecorte] });
    const outraRodada = abrirManifestoDaRodada(f.arquivo, [primeira]);
    await outraRodada(primeira, async () => nova);
    expect(lerManifesto(f.arquivo).falhas).toEqual([...falhasDasLicoes, foraDoRecorte]);
  });

  it("o escritor das lições conserva jornadas pendentes sem mudar as falhas da própria rodada", async () => {
    const f = fixture();
    f.manifesto.falhas = [...falhasDasLicoes, foraDoRecorte]; f.salvar(f.manifesto);
    const { abrirManifestoDaRodada } = await import("./capturar-jornadas");
    abrirManifestoDaRodada(f.arquivo, selecionadas);
    const { salvarManifestoDasLicoes } = await import("./capturar");
    const falhasDaRodada: string[] = [];
    salvarManifestoDasLicoes(f.arquivo, lerManifesto(f.arquivo).capturas, falhasDaRodada);
    expect(falhasDaRodada).toEqual([]); // Contagem/exit code da rodada de lições continuam próprios dela.
    expect(lerManifesto(f.arquivo).falhas).toEqual([foraDoRecorte, ...selecionadas]);
    writeFileSync(path.join(f.saida, "index.html"), "índice antes da rodada de lições");
    const montagem = f.cli("montar.ts");
    expect(montagem.status).toBe(1);
    expect(montagem.stderr).toMatch(/pendente.*demo-clinicas-primeira-consulta/s);
    expect(readFileSync(path.join(f.saida, "index.html"), "utf8")).toBe("índice antes da rodada de lições");
    const revogacaoDaRodada = ["api-tokens: revogação da rodada falhou"];
    salvarManifestoDasLicoes(f.arquivo, lerManifesto(f.arquivo).capturas, revogacaoDaRodada);
    expect(revogacaoDaRodada).toEqual(["api-tokens: revogação da rodada falhou"]);
    expect(lerManifesto(f.arquivo).falhas).toEqual([foraDoRecorte, ...selecionadas, "api-tokens: revogação da rodada falhou"]);
  });
});
