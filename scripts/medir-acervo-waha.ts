#!/usr/bin/env -S tsx
/**
 * MEDIÇÃO do acervo do WhatsApp (#3377). Só LÊ: GET no WAHA, `docker ps`/`docker stats`
 * e leitura de disco. Não escreve em lugar nenhum.
 *
 * Contra um WAHA vivo (motor NOWEB com "Guardar o histórico" ligado), mede:
 *   - memória do contêiner do WAHA (ou de um processo, com WAHA_PID);
 *   - tamanho do diretório do store (disco);
 *   - número de sessões (números pareados) e de mensagens guardadas;
 *   - crescimento por 1000 mensagens (bytes de store / mensagens * 1000).
 *
 * Toda consulta que falha vira uma entrada em `falhas` e o programa sai com 1:
 * uma contagem incompleta nunca se passa por medição. Sem WAHA_API_BASE_URL o
 * modo é só-disco, e isso é dito no stderr.
 *
 * Uso:
 *   WAHA_API_BASE_URL=http://waha:3000 WAHA_API_KEY=... WAHA_STORE_DIR=/app/.sessions \
 *     tsx scripts/medir-acervo-waha.ts
 *
 *   # só medir um diretório:
 *   tsx scripts/medir-acervo-waha.ts /caminho/do/store
 *
 * Saída: um objeto JSON em stdout. Resumo, avisos e falhas em stderr.
 * A receita para uma VPS do kit está em docs/medir-acervo-waha.md.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface Opcoes {
  storeDir: string;
  wahaUrl: string;
  apiKey: string;
  container: string;
  pid: string;
  maxChats: number;
  maxMsgsPorChat: number;
}

/** O que deu errado (vira exit 1) e o que só merece ser dito (não muda o exit). */
export interface Registro {
  falhas: string[];
  avisos: string[];
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Opcoes {
  const opts: Opcoes = {
    storeDir: env.WAHA_STORE_DIR || "/app/.sessions",
    wahaUrl: (env.WAHA_API_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: env.WAHA_API_KEY || "",
    container: env.WAHA_CONTAINER || "",
    pid: env.WAHA_PID || "",
    maxChats: 10000,
    maxMsgsPorChat: 100000,
  };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--store-dir") { opts.storeDir = argv[++i] ?? opts.storeDir; continue; }
    if (a === "--container") { opts.container = argv[++i] ?? opts.container; continue; }
    if (a === "--pid") { opts.pid = argv[++i] ?? opts.pid; continue; }
    if (a === "--max-chats") { opts.maxChats = Number(argv[++i] ?? opts.maxChats); continue; }
    if (a === "--max-msgs-por-chat") { opts.maxMsgsPorChat = Number(argv[++i] ?? opts.maxMsgsPorChat); continue; }
    if (a === "--json") continue; // a saída já é JSON; aceito por compatibilidade com o doc antigo
    if (a.startsWith("--")) throw new Error(`opção desconhecida: ${a}`);
    pos.push(a);
  }
  if (pos[0]) opts.storeDir = pos[0];
  return opts;
}

function mensagemDe(erro: unknown): string {
  if (!(erro instanceof Error)) return String(erro);
  const causa = (erro as Error & { cause?: { code?: string } }).cause?.code;
  return causa ? `${erro.message} (${causa})` : erro.message;
}

export function medirDiretorio(dir: string, reg: Registro): { diretorio: string; arquivos: number; bytes: number } | null {
  const alvo = path.resolve(dir);
  if (!fs.existsSync(alvo)) {
    reg.falhas.push(`a pasta do store não existe: ${alvo} — o disco não foi medido`);
    return null;
  }
  let arquivos = 0;
  let bytes = 0;
  const pilha: string[] = [alvo];
  while (pilha.length > 0) {
    const atual = pilha.pop() as string;
    let entradas: fs.Dirent[];
    try {
      entradas = fs.readdirSync(atual, { withFileTypes: true });
    } catch (erro) {
      reg.falhas.push(`não li a pasta ${atual}: ${mensagemDe(erro)}`);
      continue;
    }
    for (const e of entradas) {
      const cheio = path.join(atual, e.name);
      if (e.isDirectory()) {
        pilha.push(cheio);
      } else if (e.isFile()) {
        try {
          bytes += fs.statSync(cheio).size;
          arquivos += 1;
        } catch (erro) {
          reg.falhas.push(`não li o arquivo ${cheio}: ${mensagemDe(erro)}`);
        }
      }
    }
  }
  return { diretorio: alvo, arquivos, bytes };
}

const UNIDADES: Record<string, number> = {
  B: 1,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
  kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
};

/** "123.4MiB" → bytes. Formato do `docker stats --format {{.MemUsage}}`. */
export function bytesDoDocker(texto: string): number | null {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(texto.trim());
  const fator = m ? UNIDADES[m[2] ?? ""] : undefined;
  if (!m || fator === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * fator) : null;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

type Memoria = { origem: string; bytes: number; limiteBytes: number | null };

function medirMemoria(opts: Opcoes, reg: Registro): Memoria | null {
  if (opts.pid) {
    try {
      const statm = fs.readFileSync(`/proc/${Number(opts.pid)}/statm`, "utf8").trim().split(/\s+/);
      return { origem: `processo ${opts.pid}`, bytes: Number(statm[1] ?? 0) * 4096, limiteBytes: null };
    } catch (erro) {
      reg.falhas.push(`não li a memória do processo ${opts.pid}: ${mensagemDe(erro)}`);
      return null;
    }
  }
  let alvo = opts.container;
  if (!alvo) {
    // O compose não tem container_name: o nome real é <projeto>-waha-1. O rótulo do
    // compose acha o contêiner sem depender do nome do projeto nem de qual -f subiu a stack.
    let ids: string[];
    try {
      ids = docker(["ps", "-q", "--filter", "label=com.docker.compose.service=waha"]).split(/\s+/).filter(Boolean);
    } catch (erro) {
      reg.avisos.push(`docker indisponível aqui (${mensagemDe(erro)}): memória do WAHA NÃO medida — meça no host com docker stats`);
      return null;
    }
    if (ids.length !== 1) {
      reg.avisos.push(`${ids.length} contêineres do WAHA rodando: memória NÃO medida — diga qual em WAHA_CONTAINER`);
      return null;
    }
    alvo = ids[0] ?? "";
  }
  try {
    const [uso = "", limite = ""] = docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", alvo]).split("/");
    const bytes = bytesDoDocker(uso);
    if (bytes === null) throw new Error(`MemUsage ilegível: ${uso}`);
    return { origem: `contêiner ${alvo}`, bytes, limiteBytes: bytesDoDocker(limite) };
  } catch (erro) {
    reg.falhas.push(`não li a memória do contêiner ${alvo}: ${mensagemDe(erro)}`);
    return null;
  }
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function comoLista(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const data = comoObjeto(v)?.data;
  return Array.isArray(data) ? data : [];
}

function comoTexto(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function extrairVersao(v: unknown): string | null {
  if (typeof v === "string") return v;
  const obj = comoObjeto(v);
  return comoTexto(obj?.version) || comoTexto(comoObjeto(obj?.waha)?.version) || null;
}

function extrairChatId(c: unknown): string {
  const obj = comoObjeto(c);
  const direto = comoTexto(obj?.id);
  if (direto) return direto;
  const id = comoObjeto(obj?.id);
  return comoTexto(id?._serialized) || comoTexto(id?.id);
}

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const corpo = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(corpo ? `HTTP ${res.status}: ${corpo}` : `HTTP ${res.status}`);
  }
  return res.json();
}

/** Pagina de 100 em 100 até o teto. Lança na primeira página que falhar. */
async function paginar(url: string, apiKey: string, teto: number): Promise<{ itens: unknown[]; atingiuTeto: boolean }> {
  const limit = 100;
  let itens: unknown[] = [];
  for (let offset = 0; itens.length < teto; offset += limit) {
    const sep = url.includes("?") ? "&" : "?";
    const lote = comoLista(await getJson(`${url}${sep}limit=${limit}&offset=${offset}`, apiKey));
    itens = itens.concat(lote);
    if (lote.length < limit) return { itens, atingiuTeto: false };
  }
  return { itens: itens.slice(0, teto), atingiuTeto: true };
}

export interface MedidaWaha {
  url: string;
  versao: string | null;
  sessoes: number;
  mensagens: number;
  atingiuTeto: boolean;
  porSessao: Array<{ nome: string; status: string; chats: number; mensagens: number }>;
}

export async function medirWaha(opts: Opcoes, reg: Registro): Promise<MedidaWaha | null> {
  const base = opts.wahaUrl;
  if (!base) {
    reg.avisos.push("sem WAHA_API_BASE_URL: medindo só o disco");
    return null;
  }
  let versao: string | null;
  try {
    versao = extrairVersao(await getJson(`${base}/api/server/version`, opts.apiKey));
  } catch (erro) {
    reg.falhas.push(`WAHA não respondeu em ${base} (${mensagemDe(erro)}): nada do WAHA foi medido`);
    return null;
  }
  let lista: unknown[];
  try {
    lista = comoLista(await getJson(`${base}/api/sessions`, opts.apiKey));
  } catch (erro) {
    reg.falhas.push(`GET /api/sessions: ${mensagemDe(erro)}`);
    return null;
  }
  const medida: MedidaWaha = { url: base, versao, sessoes: lista.length, mensagens: 0, atingiuTeto: false, porSessao: [] };
  for (const s of lista) {
    const sessao = comoObjeto(s);
    const nome = comoTexto(sessao?.name) || comoTexto(sessao?.session);
    if (!nome) {
      reg.falhas.push("uma sessão veio sem nome em /api/sessions: não foi contada");
      continue;
    }
    const sessaoUrl = `${base}/api/${encodeURIComponent(nome)}`;
    let chats: unknown[];
    try {
      const r = await paginar(`${sessaoUrl}/chats`, opts.apiKey, opts.maxChats);
      chats = r.itens;
      medida.atingiuTeto ||= r.atingiuTeto;
    } catch (erro) {
      reg.falhas.push(`GET /api/${nome}/chats: ${mensagemDe(erro)}`);
      continue;
    }
    let mensagens = 0;
    for (const c of chats) {
      const chatId = extrairChatId(c);
      if (!chatId) {
        reg.falhas.push(`um chat da sessão ${nome} veio sem id: não foi contado`);
        continue;
      }
      try {
        const r = await paginar(
          `${sessaoUrl}/chats/${encodeURIComponent(chatId)}/messages?downloadMedia=false`,
          opts.apiKey,
          opts.maxMsgsPorChat,
        );
        mensagens += r.itens.length;
        medida.atingiuTeto ||= r.atingiuTeto;
      } catch (erro) {
        reg.falhas.push(`GET /api/${nome}/chats/${chatId}/messages: ${mensagemDe(erro)}`);
      }
    }
    medida.mensagens += mensagens;
    medida.porSessao.push({ nome, status: comoTexto(sessao?.status), chats: chats.length, mensagens });
  }
  if (medida.atingiuTeto) reg.avisos.push("a contagem parou no teto de --max-chats/--max-msgs-por-chat: é um piso, não o total");
  return medida;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  const reg: Registro = { falhas: [], avisos: [] };
  const store = medirDiretorio(opts.storeDir, reg);
  const memoria = medirMemoria(opts, reg);
  const waha = await medirWaha(opts, reg);

  const mensagens = waha?.mensagens ?? 0;
  const por1000 = (bytes: number | undefined) =>
    bytes !== undefined && mensagens > 0 ? Math.round((bytes / mensagens) * 1000) : null;

  const resultado = {
    medidoEm: new Date().toISOString(),
    completa: reg.falhas.length === 0,
    falhas: reg.falhas,
    store,
    memoria,
    waha,
    crescimentoPor1000Mensagens: { bytes: por1000(store?.bytes), memoriaBytes: por1000(memoria?.bytes) },
  };
  process.stdout.write(JSON.stringify(resultado, null, 2) + "\n");

  for (const a of reg.avisos) process.stderr.write(`aviso: ${a}\n`);
  for (const f of reg.falhas) process.stderr.write(`FALHA: ${f}\n`);
  process.stderr.write(
    [
      store ? `store: ${store.arquivos} arquivo(s), ${store.bytes} bytes` : "store: NÃO medido",
      waha ? `waha ${waha.versao ?? "?"}: ${waha.sessoes} sessão(ões) · ${waha.mensagens} mensagem(ns)` : "waha: NÃO medido",
      memoria ? `memória: ${memoria.bytes} bytes (${memoria.origem})` : "memória: NÃO medida",
    ].join(" | ") + "\n",
  );
  if (reg.falhas.length > 0) {
    process.stderr.write(`contagem INCOMPLETA: ${reg.falhas.length} consulta(s) falharam\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((erro) => {
      process.stderr.write(`${mensagemDe(erro)}\n`);
      process.exit(1);
    });
}
