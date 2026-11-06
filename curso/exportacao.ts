/** Exporta bytes e medidas já capturados; não fotografa nem preenche procedência ausente. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Nicho } from "./jornada";
import { Modulo, chaveDoPasso } from "./licao";

const SHA = /^[a-f0-9]{40}$/i;
const VERSAO = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function dataValida(valor: string, instante = false): boolean {
  if (!(INSTANTE.test(valor) || (!instante && /^\d{4}-\d{2}-\d{2}$/.test(valor)))) return false;
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) && data.toISOString().slice(0, 10) === valor.slice(0, 10);
}
const Retangulo = z.strictObject({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive() });
const Captura = z.strictObject({
  foto: z.string(), idioma: z.literal("es"), commit_fonte: z.string().regex(SHA),
  versao: z.string().regex(VERSAO), capturado_em: z.string().refine((v) => dataValida(v)),
  destaques: z.array(Retangulo.extend({ rotulo: z.string().refine((v) => Boolean(v.trim())), tipo: z.enum(["caixa", "seta", "numero"]) })),
  clicar: Retangulo.nullable(),
});
const Manifesto = z.strictObject({
  largura: z.number().int().positive().safe(), altura: z.number().int().positive().safe(),
  idioma: z.literal("es"), commit_fonte: z.string().regex(SHA), versao: z.string().regex(VERSAO),
  gerado_em: z.string().refine((v) => dataValida(v, true)), falhas: z.array(z.string()).length(0),
  capturas: z.record(z.string().regex(/^[a-z0-9-]+$/), Captura),
});
export type ManifestoExportavel = z.infer<typeof Manifesto>;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const dentro = (raiz: string, arquivo: string) => arquivo === raiz || arquivo.startsWith(`${raiz}${path.sep}`);

function estatistica(arquivo: string): fs.Stats | null {
  try { return fs.lstatSync(arquivo); } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("não foi possível inspecionar um caminho da exportação");
  }
}

/** Não segue symlink nem lê arquivo especial. Diagnósticos não mostram conteúdo ou credenciais. */
function lerRegular(arquivo: string, contexto: string): Buffer {
  const info = estatistica(arquivo);
  if (!info?.isFile() || !info.size) throw new Error(`${contexto}: arquivo regular não vazio esperado`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const atual = fs.fstatSync(fd);
    if (!atual.isFile() || !atual.size) throw new Error();
    return fs.readFileSync(fd);
  } catch { throw new Error(`${contexto}: não foi possível ler o arquivo regular`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function lerJson(arquivo: string, contexto: string): unknown {
  try { return JSON.parse(lerRegular(arquivo, contexto).toString("utf8")); }
  catch { throw new Error(`${contexto}: JSON regular ausente ou inválido`); }
}

/** Todos os descendentes existentes devem ser diretórios reais, sem desvio por link. */
function diretorios(raiz: string, relativo: string): void {
  let atual = raiz;
  for (const parte of relativo.split(path.sep).filter(Boolean)) {
    atual = path.join(atual, parte);
    const info = estatistica(atual);
    if (info && !info.isDirectory()) throw new Error("diretório da exportação é arquivo ou link; destino preservado");
  }
}

function raizReal(pasta: string, contexto: string): string {
  try {
    const real = fs.realpathSync(pasta);
    if (!fs.lstatSync(real).isDirectory()) throw new Error();
    return real;
  } catch { throw new Error(`${contexto}: diretório local ausente ou inválido`); }
}

function idsDosDados(dados: { modulos: Modulo[]; nichos: Nicho[] }): string[] {
  const ids = dados.modulos.flatMap((m) => m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id))));
  for (const n of dados.nichos) for (const j of n.jornadas) for (const c of j.cenas) ids.push(c.captura);
  if (ids.some((id) => !/^[a-z0-9-]+$/.test(id))) throw new Error("catálogo contém ID de captura inválido");
  return [...new Set(ids)].sort();
}

export function lerIdsEsperados(pastaDoCurso: string): string[] {
  const carregar = <T>(pasta: string, schema: z.ZodType<T>): T[] => {
    diretorios(pastaDoCurso, pasta);
    let nomes: string[];
    try { nomes = fs.readdirSync(path.join(pastaDoCurso, pasta)).filter((n) => n.endsWith(".json")).sort(); }
    catch { throw new Error(`catálogo local ausente: ${pasta}`); }
    return nomes.map((nome) => {
      const resultado = schema.safeParse(lerJson(path.join(pastaDoCurso, pasta, nome), `catálogo ${pasta}/${nome}`));
      if (!resultado.success) throw new Error(`catálogo local inválido: ${pasta}/${nome}`);
      return resultado.data;
    });
  };
  const modulos = carregar("licoes", Modulo);
  const nichos = carregar("demonstracoes", Nicho);
  if (!modulos.length || !nichos.length) throw new Error("catálogo local incompleto: módulos e jornadas são obrigatórios");
  return idsDosDados({ modulos, nichos });
}

export function validarManifestoExportavel(valor: unknown, ids: string[], publicado = false): ManifestoExportavel {
  const resultado = Manifesto.safeParse(valor);
  if (!resultado.success) throw new Error("manifesto incompleto ou inválido: confira idioma es, procedência, dimensões, medidas e falhas vazias");
  const manifesto = resultado.data;
  const presentes = Object.keys(manifesto.capturas).sort();
  if (JSON.stringify(presentes) !== JSON.stringify(ids)) throw new Error("manifesto com capturas ausentes ou extras em relação ao catálogo completo");
  const retangulo = (r: z.infer<typeof Retangulo>) => r.x >= 0 && r.y >= 0
    && r.x + r.w <= manifesto.largura + 0.000001 && r.y + r.h <= manifesto.altura + 0.000001;
  for (const id of ids) {
    const captura = manifesto.capturas[id]!;
    const foto = publicado ? `/curso/capturas/es/${id}.jpg` : `capturas/${id}.jpg`;
    if (captura.foto !== foto) throw new Error(`foto fora do caminho permitido: ${id}`);
    if (captura.destaques.some((d) => !retangulo(d)) || (captura.clicar !== null && !retangulo(captura.clicar))) {
      throw new Error(`retângulo fora da fotografia: ${id}`);
    }
  }
  return manifesto;
}

function lerJpeg(arquivo: string, id: string): Buffer {
  const bytes = lerRegular(arquivo, `JPEG ${id}`);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error(`fotografia não é um JPEG válido: ${id}`);
  }
  return bytes;
}

const ASSETS = path.join("public", "curso", "capturas", "es");
const ARQUIVO = path.join("conteudo", "curso", "es", "capturas.json");
type EstadoDestino = { existe: boolean; assinatura: string };

function lerEstadoDestino(site: string): EstadoDestino {
  diretorios(site, path.dirname(ASSETS)); diretorios(site, path.dirname(ARQUIVO));
  return lerEstadoDosArtefatos(path.join(site, ASSETS), path.join(site, ARQUIVO));
}

function lerEstadoDosArtefatos(pastaFotos: string, manifesto: string): EstadoDestino {
  const fotos = estatistica(pastaFotos);
  const arquivo = estatistica(manifesto);
  if (!fotos && !arquivo) return { existe: false, assinatura: "ausente" };
  if (!fotos?.isDirectory() || !arquivo?.isFile()) throw new Error("destino parcial ou sem propriedade comprovada: fotos e manifesto anteriores precisam existir juntos");
  const bytes = lerRegular(manifesto, "manifesto anterior do site");
  let bruto: unknown;
  try { bruto = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("manifesto anterior do site inválido; destino preservado"); }
  const parse = Manifesto.safeParse(bruto);
  if (!parse.success) throw new Error("manifesto anterior do site inválido; destino preservado");
  const ids = Object.keys(parse.data.capturas).sort();
  if (!ids.length) throw new Error("manifesto anterior do site vazio; destino preservado");
  validarManifestoExportavel(bruto, ids, true);
  const nomes = fs.readdirSync(pastaFotos).sort();
  if (JSON.stringify(nomes) !== JSON.stringify(ids.map((id) => `${id}.jpg`).sort())) {
    throw new Error("pasta de fotos do site contém arquivos sem vínculo com o manifesto anterior; destino preservado");
  }
  const hashes = ids.map((id) => hash(lerJpeg(path.join(pastaFotos, `${id}.jpg`), id)));
  return { existe: true, assinatura: hash(JSON.stringify([hash(bytes), nomes, hashes])) };
}

const identidade = (info: fs.Stats | null) => info ? `${info.dev}:${info.ino}` : "ausente";
function assinaturaArquivo(arquivo: string): string {
  return `${identidade(estatistica(arquivo))}:${hash(lerRegular(arquivo, "arquivo da exportação"))}`;
}
function conferirPasta(pasta: string, dona: string, arquivos: Map<string, string>): boolean {
  const info = estatistica(pasta);
  return Boolean(info?.isDirectory()) && identidade(info) === dona
    && JSON.stringify(fs.readdirSync(pasta).sort()) === JSON.stringify([...arquivos.keys()].sort())
    && [...arquivos].every(([nome, assinatura]) => assinaturaArquivo(path.join(pasta, nome)) === assinatura);
}

/** Só lê os IDs do artefato PT; o conteúdo e o programa canônicos ficam intocados. */
function validarCatalogoDoSite(site: string, ids: string[]): string {
  diretorios(site, path.join("public", "curso"));
  const bytes = lerRegular(path.join(site, "public", "curso", "index.html"), "curso canônico do site");
  const bloco = /<script id="dados" type="application\/json">([\s\S]*?)<\/script>/.exec(bytes.toString("utf8"));
  let dados: unknown;
  try { dados = JSON.parse(bloco?.[1] ?? ""); } catch { throw new Error("curso canônico do site sem catálogo JSON válido"); }
  const resultado = z.object({ modulos: z.array(Modulo).min(1), nichos: z.array(Nicho).min(1) }).safeParse(dados);
  if (!resultado.success || JSON.stringify(idsDosDados(resultado.data)) !== JSON.stringify(ids)) {
    throw new Error("catálogo do site difere da fonte local; sincronize o conteúdo PT antes de exportar as fotos");
  }
  return hash(bytes);
}

export function exportarCapturas(opcoes: { idioma: "es"; saida: string; site: string; curso?: string }): { idioma: "es"; capturas: number; manifesto: string; assets: string } {
  if (opcoes.idioma !== "es") throw new Error("o exportador aceita somente --idioma es; o curso PT canônico não é alterado");
  const saida = raizReal(opcoes.saida, "origem das capturas");
  const site = raizReal(opcoes.site, "clone do site");
  if (dentro(saida, site) || dentro(site, saida)) throw new Error("origem e site precisam estar em árvores separadas");
  const curso = raizReal(opcoes.curso ?? fileURLToPath(new URL(".", import.meta.url)), "catálogo do curso");
  const ids = lerIdsEsperados(curso);
  diretorios(saida, "capturas");
  const arquivoFonte = path.join(saida, "capturas.json");
  const bytesFonte = lerRegular(arquivoFonte, "manifesto da origem");
  let bruto: unknown;
  try { bruto = JSON.parse(bytesFonte.toString("utf8")); } catch { throw new Error("manifesto da origem não contém JSON válido"); }
  const fonte = validarManifestoExportavel(bruto, ids);
  const hashes = new Map(ids.map((id) => [id, hash(lerJpeg(path.join(saida, "capturas", `${id}.jpg`), id))]));
  const catalogoSite = validarCatalogoDoSite(site, ids);
  const anterior = lerEstadoDestino(site);
  const publicado = { ...fonte, capturas: Object.fromEntries(ids.map((id) => [id, { ...fonte.capturas[id]!, foto: `/curso/capturas/es/${id}.jpg` }])) };
  validarManifestoExportavel(publicado, ids, true);
  const json = `${JSON.stringify(publicado, null, 2)}\n`;
  // Tudo acima é somente leitura. Stage e lock só nascem com fonte e destino válidos.
  const lock = path.join(site, ".curso-exportar-es.lock");
  try { fs.mkdirSync(lock); } catch { throw new Error("exportação ES já reservada ou clone sem permissão; confira a sessão responsável pelo lock"); }
  let stage: string | undefined;
  let conservar = false;
  const criados: string[] = [];
  try {
    stage = fs.mkdtempSync(path.join(site, ".curso-exportar-es-"));
    const novas = path.join(stage, "novas-capturas");
    const novoManifesto = path.join(stage, "novo-capturas.json");
    fs.mkdirSync(novas);
    for (const id of ids) {
      diretorios(saida, "capturas");
      const bytes = lerJpeg(path.join(saida, "capturas", `${id}.jpg`), id);
      if (hash(bytes) !== hashes.get(id)) throw new Error("captura mudou durante a preparação; repita quando a fonte estiver estável");
      fs.writeFileSync(path.join(novas, `${id}.jpg`), bytes, { flag: "wx" });
      if (hash(lerJpeg(path.join(novas, `${id}.jpg`), id)) !== hashes.get(id)) throw new Error("cópia da fotografia não confere");
    }
    fs.writeFileSync(novoManifesto, json, { flag: "wx" });
    diretorios(saida, "capturas");
    if (hash(lerRegular(arquivoFonte, "manifesto da origem")) !== hash(bytesFonte)
      || JSON.stringify(lerIdsEsperados(curso)) !== JSON.stringify(ids)
      || ids.some((id) => hash(lerJpeg(path.join(saida, "capturas", `${id}.jpg`), id)) !== hashes.get(id))
      || validarCatalogoDoSite(site, ids) !== catalogoSite || lerEstadoDestino(site).assinatura !== anterior.assinatura) {
      throw new Error("fonte ou destino mudou durante a preparação; trabalho concorrente preservado");
    }
    for (const relativo of [path.dirname(ASSETS), path.dirname(ARQUIVO)]) {
      let atual = site;
      for (const parte of relativo.split(path.sep)) {
        atual = path.join(atual, parte);
        const info = estatistica(atual);
        if (info && !info.isDirectory()) throw new Error("diretório de destino mudou durante a preparação");
        if (!info) { fs.mkdirSync(atual); criados.push(atual); }
      }
    }
    const destinoFotos = path.join(site, ASSETS);
    const destinoManifesto = path.join(site, ARQUIVO);
    const antigas = path.join(stage, "capturas-anteriores");
    const manifestoAntigo = path.join(stage, "manifesto-anterior.json");
    let fotosGuardadas = false; let manifestoGuardado = false;
    let fotosInstaladas = false; let manifestoInstalado = false;
    let donaDasFotos = "";
    const arquivosInstalados = new Map<string, string>();
    const assinaturaManifesto = assinaturaArquivo(novoManifesto);
    const fotosRetiradas = path.join(stage, "fotos-retiradas");
    const manifestoRetirado = path.join(stage, "manifesto-retirado.json");
    let retirouFotos = false; let retirouManifesto = false;
    const recuperacao = () => {
      conservar = true;
      return new Error(`alteração concorrente ou falha de restauração; publicação bloqueada, recupere os arquivos preservados em ${path.basename(stage!)}`);
    };
    const conferirAnteriores = () => !anterior.existe || lerEstadoDosArtefatos(
      fotosGuardadas ? antigas : destinoFotos, manifestoGuardado ? manifestoAntigo : destinoManifesto,
    ).assinatura === anterior.assinatura;
    const conferirInstalados = () => {
      const fotosConferem = fotosInstaladas ? conferirPasta(destinoFotos, donaDasFotos, arquivosInstalados)
        : anterior.existe && !fotosGuardadas || !estatistica(destinoFotos);
      const manifestoConfere = manifestoInstalado ? assinaturaArquivo(destinoManifesto) === assinaturaManifesto
        : anterior.existe && !manifestoGuardado || !estatistica(destinoManifesto);
      return fotosConferem && manifestoConfere;
    };
    try {
      if (anterior.existe) {
        fs.renameSync(destinoFotos, antigas); fotosGuardadas = true;
        fs.renameSync(destinoManifesto, manifestoAntigo); manifestoGuardado = true;
        // A última leitura não protege a janela do rename: confira o que foi tomado.
        if (!conferirAnteriores()) throw recuperacao();
      }
      // mkdir/link são exclusivos: EEXIST preserva um arquivo criado por editor/git,
      // que não participam do lock dos exportadores. Nunca use rename que sobrescreva.
      fs.mkdirSync(destinoFotos); fotosInstaladas = true;
      donaDasFotos = identidade(estatistica(destinoFotos));
      for (const id of ids) {
        const nome = `${id}.jpg`;
        const assinatura = assinaturaArquivo(path.join(novas, nome));
        fs.linkSync(path.join(novas, nome), path.join(destinoFotos, nome));
        arquivosInstalados.set(nome, assinatura);
      }
      fs.linkSync(novoManifesto, destinoManifesto); manifestoInstalado = true;
      if (!conferirAnteriores() || !conferirInstalados()) throw recuperacao();
    } catch {
      if (conservar) throw recuperacao();
      try {
        if (!conferirAnteriores() || !conferirInstalados()) throw recuperacao();
        // Tome para uma pasta privada ANTES de decidir que pode descartar. Uma
        // edição entre a checagem e a tomada precisa continuar acessível no stage.
        if (manifestoInstalado) {
          fs.renameSync(destinoManifesto, manifestoRetirado); retirouManifesto = true;
          if (assinaturaArquivo(manifestoRetirado) !== assinaturaManifesto) throw recuperacao();
        }
        if (fotosInstaladas) {
          fs.renameSync(destinoFotos, fotosRetiradas); retirouFotos = true;
          if (!conferirPasta(fotosRetiradas, donaDasFotos, arquivosInstalados)) throw recuperacao();
        }
        if (!conferirAnteriores()) throw recuperacao();
        // Restaurar também é exclusivo. Se outra sessão ocupou o caminho,
        // conservamos seus bytes e os backups, sem renomear por cima deles.
        if (fotosGuardadas) {
          fs.mkdirSync(destinoFotos);
          for (const nome of fs.readdirSync(antigas)) fs.linkSync(path.join(antigas, nome), path.join(destinoFotos, nome));
        }
        if (manifestoGuardado) fs.linkSync(manifestoAntigo, destinoManifesto);
        if (lerEstadoDestino(site).assinatura !== anterior.assinatura
          || (retirouManifesto && assinaturaArquivo(manifestoRetirado) !== assinaturaManifesto)
          || (retirouFotos && !conferirPasta(fotosRetiradas, donaDasFotos, arquivosInstalados))) throw recuperacao();
      } catch {
        throw recuperacao();
      }
      throw new Error("falha na troca dos arquivos; destino anterior restaurado");
    }
    return { idioma: "es", capturas: ids.length, manifesto: "conteudo/curso/es/capturas.json", assets: "public/curso/capturas/es/" };
  } catch (erro) {
    if (erro instanceof Error && /restaurad|recupere|mudou durante/.test(erro.message)) throw erro;
    throw new Error("falha ao preparar a exportação; destino anterior preservado, confira espaço e permissões");
  } finally {
    if (!conservar) {
      try {
        if (stage) fs.rmSync(stage, { recursive: true, force: true });
        for (const pasta of criados.reverse()) {
          try { fs.rmdirSync(pasta); } catch { /* Só remove diretórios criados pela sessão que continuem vazios. */ }
        }
        fs.rmdirSync(lock);
      } catch {
        throw new Error("não foi possível limpar o stage da exportação; confira os artefatos e a reserva antes de publicar");
      }
    }
  }
}
