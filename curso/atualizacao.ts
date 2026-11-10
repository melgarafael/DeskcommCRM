/**
 * Triagem conservadora do curso entre dois commits. O mapa sugere candidatos;
 * não é um grafo de dependências nem prova de que uma foto continua atual.
 * Só lê objetos do Git: não abre .env, contas da demonstração ou capturas.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { z } from "zod";

const Idioma = z.enum(["pt-BR", "es"]);
export type IdiomaDoPlano = z.infer<typeof Idioma>;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-z0-9-]+$/);
const Publicacao = z.object({
  versao: z.literal(1),
  commit_fonte: sha,
  site_commit: sha,
  idiomas: z.array(Idioma).min(1),
  publicado_em: z.iso.datetime({ offset: true }),
});
const ModuloDoMapa = z.object({
  id,
  tela: z.string().regex(/^\/(app|admin)\//),
  licoes: z.array(z.object({ id, passos: z.array(z.object({ rota: z.string().optional() })) })).min(1),
});
const NichoDoMapa = z.object({
  id,
  jornadas: z.array(z.object({ id, montagem: z.array(z.object({ modulo: id, licao: id })) })).min(1),
});
type ModuloDoMapa = z.infer<typeof ModuloDoMapa>;
type NichoDoMapa = z.infer<typeof NichoDoMapa>;
type Razao = { arquivo: string | null; motivo: string };

export type PlanoDeAtualizacao = {
  versao: 1;
  base: string | null;
  head: string;
  origem_base: "publicacao_versionada" | "informada" | "ausente";
  modo: "completa" | "candidatos" | "sem-recaptura";
  idiomas: IdiomaDoPlano[];
  idiomas_sem_publicacao: IdiomaDoPlano[];
  arquivos_alterados: string[];
  arquivos_sem_impacto_visual_direto: string[];
  modulos_candidatos: Array<{ id: string; tela: string; licoes: string[]; razoes: Razao[] }>;
  jornadas_candidatas: Array<{ nicho: string; id: string; razoes: Razao[] }>;
  pendencias_nao_mapeadas: string[];
  revisao_ia_necessaria: boolean;
  razoes_rodada_completa: string[];
  limites: string[];
};

/** Não usa shell, não interpola ref como opção e não devolve diagnóstico com conteúdo do Git. */
function git(repositorio: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repositorio, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    throw new Error("não foi possível ler o repositório Git; confira o clone e os objetos locais");
  }
}

function commit(repositorio: string, ref: string, campo: "base" | "head"): string {
  try {
    return sha.parse(git(repositorio, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim());
  } catch {
    throw new Error(`${campo} inválido: informe um commit existente no clone`);
  }
}

function ancestral(repositorio: string, base: string, head: string): boolean {
  const resultado = spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
    cwd: repositorio, stdio: "pipe", timeout: 15_000,
  });
  if (resultado.status === 0) return true;
  if (resultado.status === 1) return false;
  throw new Error("não foi possível verificar a ancestralidade; confira o histórico local");
}

function lerJsonDoCommit(repositorio: string, head: string, arquivo: string): unknown {
  try { return JSON.parse(git(repositorio, ["show", `${head}:${arquivo}`])); } catch {
    throw new Error(`JSON versionado ausente ou inválido: ${arquivo}`);
  }
}

function catalogo(repositorio: string, head: string): { modulos: ModuloDoMapa[]; nichos: NichoDoMapa[] } {
  const arquivos = git(repositorio, ["ls-tree", "-rz", "--name-only", head, "--", "curso/licoes/", "curso/demonstracoes/"])
    .split("\0").filter(Boolean).sort();
  const carregar = <T>(padrao: RegExp, schema: z.ZodType<T>): T[] => arquivos.filter((a) => padrao.test(a)).map((a) => {
    const dado = schema.safeParse(lerJsonDoCommit(repositorio, head, a));
    if (!dado.success) throw new Error(`catálogo do curso inválido: ${a}`);
    return dado.data;
  });
  const modulos = carregar(/^curso\/licoes\/[^/]+\.json$/, ModuloDoMapa);
  const nichos = carregar(/^curso\/demonstracoes\/[^/]+\.json$/, NichoDoMapa);
  if (!modulos.length) throw new Error("head sem módulos versionados em curso/licoes; planejamento recusado");
  if (new Set(modulos.map((m) => m.id)).size !== modulos.length || new Set(nichos.map((n) => n.id)).size !== nichos.length) {
    throw new Error("catálogo do curso com identificadores repetidos");
  }
  return { modulos, nichos };
}

const rotaLimpa = (rota: string) => rota.split(/[?#]/)[0]!.replace(/\/$/, "");
const rotasRelacionadas = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Só declara ausência de efeito visual DIRETO; a IA ainda lê o diff da entrega. */
function semImpactoVisualDireto(arquivo: string): boolean {
  return /(^|\/)(tests|__tests__)\//.test(arquivo)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(arquivo)
    || /^(docs|evidence|\.changes|\.github|\.agents|\.claude)\//.test(arquivo)
    || /^(README|CHANGELOG|CLAUDE|AGENTS)\.md$/.test(arquivo)
    || /^curso\/(saida\/|publicacao\.json$|atualizacao\.ts$|planejar-atualizacao\.ts$)/.test(arquivo);
}

export function planejarAtualizacao(opcoes: {
  repositorio: string;
  head?: string;
  base?: string;
  idiomas?: IdiomaDoPlano[];
}): PlanoDeAtualizacao {
  const { repositorio } = opcoes;
  const head = commit(repositorio, opcoes.head ?? "HEAD", "head");
  const idiomas = [...new Set(z.array(Idioma).min(1).parse(opcoes.idiomas ?? ["pt-BR", "es"]))].sort();
  const { modulos, nichos } = catalogo(repositorio, head);
  let base: string | null = null;
  let origem: PlanoDeAtualizacao["origem_base"] = "ausente";
  let publicados: IdiomaDoPlano[] = [];
  const rodadaCompleta: string[] = [];
  let reciboIncompleto = false;
  // O registro precisa estar no commit comparado. Arquivo solto no disco não comprova publicação.
  const arquivosDoCurso = git(repositorio, ["ls-tree", "-z", "--name-only", head, "--", "curso/publicacao.json"]);
  if (arquivosDoCurso) {
    let publicacao: z.infer<typeof Publicacao> | undefined;
    try {
      const resultado = Publicacao.safeParse(lerJsonDoCommit(repositorio, head, "curso/publicacao.json"));
      if (resultado.success) publicacao = resultado.data;
      else reciboIncompleto = true;
    } catch { reciboIncompleto = true; }
    if (publicacao) {
      try {
        const publicado = commit(repositorio, publicacao.commit_fonte, "base");
        if (ancestral(repositorio, publicado, head)) {
          base = publicado;
          publicados = publicacao.idiomas;
          origem = "publicacao_versionada";
        }
      } catch { /* Histórico raso não permite afirmar que a base está disponível. */ }
    }
  }
  if (opcoes.base !== undefined) {
    base = commit(repositorio, opcoes.base, "base");
    if (!ancestral(repositorio, base, head)) throw new Error("base não é ancestral de head; não use um intervalo de outra linha de histórico");
    origem = "informada";
  }
  if (!base) rodadaCompleta.push(reciboIncompleto
    ? "Recibo de publicação incompleto ou inválido: exige commit_fonte e site_commit com SHA completo, idiomas e data; rodada completa."
    : "Sem publicação anterior válida e ancestral comprovada no clone; primeira rodada completa.");
  // Uma base informada é útil na triagem, mas não comprova idiomas já publicados.
  const idiomasSemPublicacao = idiomas.filter((i) => !publicados.includes(i));
  if (origem !== "informada" && base && idiomasSemPublicacao.length) {
    rodadaCompleta.push(`Idiomas sem publicação comprovada: ${idiomasSemPublicacao.join(", ")}; capturar rodada completa.`);
  }
  const alterados = base
    ? [...new Set(git(repositorio, ["diff", "--name-only", "-z", "--no-renames", base, head, "--"]).split("\0").filter(Boolean))].sort()
    : [];
  const selecionados = new Map<string, { licoes: Set<string>; razoes: Razao[] }>();
  const jornadas = new Map<string, { nicho: string; id: string; razoes: Razao[] }>();
  const pendencias = new Set<string>();
  const semImpacto: string[] = [];
  const selecionar = (m: ModuloDoMapa, razao: Razao, licoes = m.licoes.map((l) => l.id)) => {
    const entrada = selecionados.get(m.id) ?? { licoes: new Set<string>(), razoes: [] };
    for (const l of licoes) entrada.licoes.add(l);
    if (!entrada.razoes.some((r) => r.arquivo === razao.arquivo && r.motivo === razao.motivo)) entrada.razoes.push(razao);
    selecionados.set(m.id, entrada);
  };
  const selecionarJornada = (nicho: string, jornada: string, razao: Razao) => {
    const chave = `${nicho}/${jornada}`;
    const entrada = jornadas.get(chave) ?? { nicho, id: jornada, razoes: [] };
    if (!entrada.razoes.some((r) => r.arquivo === razao.arquivo && r.motivo === razao.motivo)) entrada.razoes.push(razao);
    jornadas.set(chave, entrada);
  };
  const todos = (razao: Razao) => {
    for (const m of modulos) selecionar(m, razao);
    for (const n of nichos) for (const j of n.jornadas) selecionarJornada(n.id, j.id, razao);
  };
  for (const motivo of rodadaCompleta) todos({ arquivo: null, motivo });

  for (const arquivo of alterados) {
    if (semImpactoVisualDireto(arquivo)) { semImpacto.push(arquivo); continue; }
    const moduloDoCurso = /^curso\/(?:licoes\/([^/]+)\.json|semear\/([^/]+)\.ts)$/.exec(arquivo);
    const modulo = moduloDoCurso && modulos.find((m) => m.id === (moduloDoCurso[1] ?? moduloDoCurso[2]));
    if (modulo) {
      selecionar(modulo, { arquivo, motivo: "Lição ou semente do próprio módulo mudou; revisar todas as suas aulas." });
      continue;
    }
    const demonstracao = /^curso\/demonstracoes\/([^/]+)\.json$/.exec(arquivo);
    const nicho = demonstracao && nichos.find((n) => n.id === demonstracao[1]);
    if (nicho) {
      for (const j of nicho.jornadas) selecionarJornada(nicho.id, j.id, { arquivo, motivo: "O roteiro do nicho mudou; revisar as cenas." });
      continue;
    }
    // A pasta de uma rota não confina seus componentes: ListaDeTarefas, por
    // exemplo, também é importada pela Inbox e pelo Funil. Só entradas do
    // framework usam a inferência local; os demais arquivos caem no mapa global.
    if (/^app\/(app|admin)\//.test(arquivo) && /\/(?:page|layout|loading|error|not-found|template)\.[jt]sx?$/.test(arquivo)
      && !arquivo.split("/").some((p) => p.startsWith("_"))) {
      const partes = arquivo.slice(4).split("/").slice(0, -1).filter((p) => !/^\(.*\)$/.test(p));
      const rota = `/${partes.join("/")}`;
      const relacionados = modulos.filter((m) => rotasRelacionadas(rotaLimpa(m.tela), rota)
        || m.licoes.some((l) => l.passos.some((p) => p.rota && rotasRelacionadas(rotaLimpa(p.rota), rota))));
      if (relacionados.length) {
        for (const m of relacionados) selecionar(m, { arquivo, motivo: `Arquivo sob ${rota}; relação por rota inferida, sujeita à revisão da IA.` });
        continue;
      }
    }
    // Componentes, libs, hooks, APIs, banco e arquivos sem mapa podem alterar qualquer tela.
    // Preferir revisão ampla a desaparecer silenciosamente com uma mudança compartilhada.
    pendencias.add(arquivo);
    todos({ arquivo, motivo: "Mudança compartilhada ou sem mapa específico; revisão global e recaptura candidata de todos os módulos e jornadas." });
  }
  for (const n of nichos) for (const j of n.jornadas) {
    const referencias = j.montagem.filter((r) => selecionados.get(r.modulo)?.licoes.has(r.licao));
    for (const ref of referencias) selecionarJornada(n.id, j.id, {
      arquivo: null, motivo: `A jornada usa a aula candidata ${ref.modulo}/${ref.licao}; relação declarada no roteiro.`,
    });
  }
  const candidatos = modulos.filter((m) => selecionados.has(m.id)).map((m) => ({
    id: m.id, tela: m.tela, licoes: [...selecionados.get(m.id)!.licoes].sort(), razoes: selecionados.get(m.id)!.razoes,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const jornadasCandidatas = [...jornadas.values()].sort((a, b) => `${a.nicho}/${a.id}`.localeCompare(`${b.nicho}/${b.id}`));
  return {
    versao: 1, base, head, origem_base: origem,
    modo: rodadaCompleta.length ? "completa" : candidatos.length || jornadasCandidatas.length ? "candidatos" : "sem-recaptura",
    idiomas, idiomas_sem_publicacao: idiomasSemPublicacao,
    arquivos_alterados: alterados, arquivos_sem_impacto_visual_direto: semImpacto,
    modulos_candidatos: candidatos, jornadas_candidatas: jornadasCandidatas,
    pendencias_nao_mapeadas: [...pendencias].sort(),
    revisao_ia_necessaria: origem === "informada" || Boolean(rodadaCompleta.length || candidatos.length || jornadasCandidatas.length),
    razoes_rodada_completa: rodadaCompleta,
    limites: [
      "Compara apenas commits; alterações locais não entram no intervalo.",
      "Candidatos são uma triagem conservadora, não cobertura exata nem autorização de publicação.",
      "A IA deve ler o diff, conferir a interface real em cada idioma e justificar qualquer redução do recorte.",
      "Sem base, arquivos_alterados fica vazio porque não existe intervalo comprovado; todos os módulos e jornadas são candidatos.",
    ],
  };
}
