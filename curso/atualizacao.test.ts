// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planejarAtualizacao } from "./atualizacao";

const temporarias: string[] = [];
const raiz = process.cwd();
const ambiente: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test" };

function fixture() {
  const pasta = mkdtempSync(path.join(tmpdir(), "curso-plano-"));
  temporarias.push(pasta);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: pasta, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ambiente,
  }).trim();
  const escrever = (arquivo: string, conteudo: string) => {
    mkdirSync(path.dirname(path.join(pasta, arquivo)), { recursive: true });
    writeFileSync(path.join(pasta, arquivo), conteudo);
  };
  const salvar = () => {
    git("add", "--", ".");
    git("-c", "user.name=Fixture do curso", "-c", "user.email=curso@example.invalid", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  for (const modulo of ["agenda", "inbox"]) escrever(`curso/licoes/${modulo}.json`, JSON.stringify({
    id: modulo, tela: `/app/${modulo}`, licoes: ["conhecendo", "operando"].map((id) => ({ id, passos: [{ rota: `/app/${modulo}` }] })),
  }));
  escrever("curso/demonstracoes/clinicas.json", JSON.stringify({
    id: "clinicas", jornadas: [
      { id: "consulta", montagem: [{ modulo: "agenda", licao: "operando" }] },
      { id: "duvida", montagem: [{ modulo: "inbox", licao: "conhecendo" }] },
    ],
  }));
  escrever("app/app/agenda/page.tsx", "export default function Agenda() { return null; }\n");
  const fonte = salvar();
  const publicar = (commitFonte = fonte, idiomas = ["pt-BR", "es"]) => {
    escrever("curso/publicacao.json", JSON.stringify({ versao: 1, commit_fonte: commitFonte, site_commit: "c".repeat(40), idiomas, publicado_em: "2026-10-27T12:00:00Z" }));
    return salvar();
  };
  const planejar = (opcoes: Partial<Parameters<typeof planejarAtualizacao>[0]> = {}) => planejarAtualizacao({ repositorio: pasta, ...opcoes });
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(raiz, "node_modules/tsx/dist/cli.mjs"), path.join(raiz, "curso/planejar-atualizacao.ts"), ...args], {
    cwd: pasta, encoding: "utf8", timeout: 20_000, env: ambiente,
  });
  return { pasta, git, escrever, salvar, fonte, publicar, planejar, cli };
}

afterEach(() => { for (const pasta of temporarias.splice(0)) rmSync(pasta, { recursive: true, force: true }); });

describe("planejamento do curso sobre objetos Git reais", () => {
  it("sem publicação comprovada seleciona todos, sem inventar um intervalo", () => {
    const f = fixture();
    const plano = f.planejar();
    expect(plano).toMatchObject({ base: null, head: f.fonte, origem_base: "ausente", modo: "completa", revisao_ia_necessaria: true, arquivos_alterados: [] });
    expect(plano.modulos_candidatos.map((m) => m.id)).toEqual(["agenda", "inbox"]);
    expect(plano.jornadas_candidatas).toHaveLength(2);
    expect(plano.razoes_rodada_completa).not.toHaveLength(0);
  });

  it("sem alteração desde a fonte publicada não pede recaptura", () => {
    const f = fixture();
    const head = f.publicar();
    const plano = f.planejar();
    expect(plano).toMatchObject({ base: f.fonte, head, origem_base: "publicacao_versionada", modo: "sem-recaptura", revisao_ia_necessaria: false });
    expect(plano.arquivos_alterados).toEqual(["curso/publicacao.json"]);
    expect(plano.modulos_candidatos).toEqual([]);
    expect(plano.jornadas_candidatas).toEqual([]);
  });

  it("não usa registro de publicação solto na árvore de trabalho", () => {
    const f = fixture();
    f.escrever("curso/publicacao.json", JSON.stringify({ versao: 1, commit_fonte: f.fonte, site_commit: "c".repeat(40), idiomas: ["pt-BR", "es"], publicado_em: "2026-10-27T12:00:00Z" }));
    expect(f.planejar()).toMatchObject({ origem_base: "ausente", modo: "completa" });
  });

  it("uma tela seleciona suas aulas e só as jornadas que as referenciam", () => {
    const f = fixture();
    f.publicar();
    f.escrever("app/app/agenda/page.tsx", "export default function Agenda() { return 'Agenda atual'; }\n");
    const head = f.salvar();
    const plano = f.planejar();
    expect(plano.head).toBe(head);
    expect(plano.modo).toBe("candidatos");
    expect(plano.modulos_candidatos).toMatchObject([{ id: "agenda", licoes: ["conhecendo", "operando"] }]);
    expect(plano.modulos_candidatos[0]!.razoes[0]!.motivo).toContain("inferida");
    expect(plano.jornadas_candidatas.map((j) => j.id)).toEqual(["consulta"]);
    expect(plano.pendencias_nao_mapeadas).toEqual([]);
  });

  it.each(["components/ui/button.tsx", "lib/navigation/catalogo.ts", "app/api/v1/agenda/route.ts", "app/layout.tsx", "supabase/baseline.sql"])("%s não silencia nenhum módulo", (arquivo) => {
    const f = fixture();
    f.publicar(); f.escrever(arquivo, "mudança compartilhada\n"); f.salvar();
    const plano = f.planejar();
    expect(plano.modulos_candidatos.map((m) => m.id)).toEqual(["agenda", "inbox"]);
    expect(plano.jornadas_candidatas).toHaveLength(2);
    expect(plano.pendencias_nao_mapeadas).toContain(arquivo);
    expect(plano.revisao_ia_necessaria).toBe(true);
  });

  it("layout de área alcança todos os seus módulos sem alegar dependência exata", () => {
    const f = fixture();
    f.publicar(); f.escrever("app/app/layout.tsx", "export default () => null;\n"); f.salvar();
    expect(f.planejar().modulos_candidatos.map((m) => m.id)).toEqual(["agenda", "inbox"]);
  });

  it("componente sob uma rota continua global quando outra tela o importa", () => {
    const f = fixture();
    f.escrever("app/app/agenda/_components/ListaDeTarefas.tsx", "export const ListaDeTarefas = () => null;\n");
    f.escrever("app/app/inbox/page.tsx", "import { ListaDeTarefas } from '../agenda/_components/ListaDeTarefas'; export default ListaDeTarefas;\n");
    const publicado = f.salvar(); f.publicar(publicado);
    f.escrever("app/app/agenda/_components/ListaDeTarefas.tsx", "export const ListaDeTarefas = () => 'Componente alterado';\n"); f.salvar();
    const plano = f.planejar();
    expect(plano.modulos_candidatos.map((m) => m.id)).toEqual(["agenda", "inbox"]);
    expect(plano.pendencias_nao_mapeadas).toContain("app/app/agenda/_components/ListaDeTarefas.tsx");
    expect(plano.revisao_ia_necessaria).toBe(true);
  });

  it("renomear uma tela conserva o caminho removido e o novo na triagem", () => {
    const f = fixture();
    f.publicar(); f.git("mv", "app/app/agenda/page.tsx", "app/app/agenda/novo.tsx"); f.salvar();
    expect(f.planejar().arquivos_alterados).toEqual(["app/app/agenda/novo.tsx", "app/app/agenda/page.tsx", "curso/publicacao.json"]);
    expect(f.planejar().modulos_candidatos.map((m) => m.id)).toEqual(["agenda", "inbox"]);
  });

  it("idioma ainda não publicado exige uma rodada completa", () => {
    const f = fixture();
    f.publicar(f.fonte, ["pt-BR"]);
    expect(f.planejar()).toMatchObject({ modo: "completa", idiomas_sem_publicacao: ["es"] });
    expect(f.planejar({ idiomas: ["pt-BR"] })).toMatchObject({ modo: "sem-recaptura", idiomas_sem_publicacao: [] });
  });

  it.each(["inexistente", "--help", "HEAD; touch NAO_EXECUTAR"])("recusa base/head inválidos: %s", (ref) => {
    const f = fixture();
    expect(() => f.planejar({ base: ref })).toThrow("base inválido");
    expect(() => f.planejar({ head: ref })).toThrow("head inválido");
    expect(existsSync(path.join(f.pasta, "NAO_EXECUTAR"))).toBe(false);
  });

  it("recusa base explícita de outra linha de histórico", () => {
    const f = fixture();
    f.publicar(); const principal = f.git("rev-parse", "HEAD");
    f.git("checkout", "-q", "--detach", f.fonte);
    f.escrever("lateral.md", "outra linha\n"); const lateral = f.salvar();
    f.git("checkout", "-q", "--detach", principal);
    expect(() => f.planejar({ base: lateral })).toThrow("base não é ancestral");
  });

  it("registro inválido ou commit publicado indisponível pede rodada completa", () => {
    const f = fixture();
    f.publicar("a".repeat(40));
    expect(f.planejar()).toMatchObject({ modo: "completa", base: null });
    f.escrever("curso/publicacao.json", "{registro legado"); f.salvar();
    expect(f.planejar()).toMatchObject({ modo: "completa", base: null });
  });

  it.each([undefined, "curto"])("recibo sem vínculo SHA com o site pede rodada completa: %s", (siteCommit) => {
    const f = fixture();
    f.escrever("curso/publicacao.json", JSON.stringify({ versao: 1, commit_fonte: f.fonte, idiomas: ["pt-BR", "es"], publicado_em: "2026-10-27T12:00:00Z", site_commit: siteCommit })); f.salvar();
    const plano = f.planejar();
    expect(plano).toMatchObject({ base: null, origem_base: "ausente", modo: "completa", revisao_ia_necessaria: true });
    expect(plano.razoes_rodada_completa.join(" ")).toContain("site_commit");
    expect(plano.modulos_candidatos).toHaveLength(2);
  });

  it("base informada não vira publicação comprovada, mesmo sem mudanças", () => {
    const f = fixture();
    const plano = f.planejar({ base: f.fonte });
    expect(plano).toMatchObject({ base: f.fonte, head: f.fonte, origem_base: "informada", modo: "sem-recaptura", revisao_ia_necessaria: true });
    expect(plano.modulos_candidatos).toEqual([]);
  });

  it("o JSON é determinístico e não contém conteúdo de arquivo ou segredo", () => {
    const f = fixture();
    f.publicar(); f.escrever("lib/compartilhado.ts", 'const segredo = "SEGREDO_INERTE_DA_FIXTURE";\n'); f.salvar();
    const json = JSON.stringify(f.planejar());
    expect(json).toBe(JSON.stringify(f.planejar()));
    expect(json).not.toContain("SEGREDO_INERTE_DA_FIXTURE");
    expect(json).not.toContain("const segredo");
  });

  it("CLI real tem ajuda e grava plano idêntico à saída pública", () => {
    const f = fixture();
    f.publicar();
    const ajuda = f.cli("--help");
    expect(ajuda.status).toBe(0); expect(ajuda.stdout).toContain("--base <ref>");
    const resultado = f.cli("--idioma", "pt-BR", "--saida", "curso/saida/plano.json");
    expect(resultado.status).toBe(0); expect(resultado.stderr).toBe("");
    expect(readFileSync(path.join(f.pasta, "curso/saida/plano.json"), "utf8")).toBe(resultado.stdout);
    expect(JSON.parse(resultado.stdout)).toMatchObject({ modo: "sem-recaptura", idiomas: ["pt-BR"], base: f.fonte });
  });

  it("CLI real falha alto sem publicar JSON ou arquivo se a base é inválida", () => {
    const f = fixture();
    const resultado = f.cli("--base", "inexistente", "--saida", "curso/saida/plano.json");
    expect(resultado.status).toBe(1); expect(resultado.stdout).toBe("");
    expect(resultado.stderr).toContain("base inválido");
    expect(existsSync(path.join(f.pasta, "curso/saida/plano.json"))).toBe(false);
  });
});
