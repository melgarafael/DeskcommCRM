/**
 * Roteiro das avaliações que ainda seguram três escolhas das frentes de tokens:
 * C (LLM_TOOL_SCHEMA_SEM_PADRAO), F5 (LEAD_CONTEXT_HISTORY_FORMAT=linhas) e G
 * (fechamento no modelo econômico). Procedimento, corpus, critérios e custo:
 * docs/runbooks/avaliacoes-de-tokens.md.
 *
 *   plano      — execuções previstas, tokens contados (o200k) e custo por modelo,
 *                com e sem o cache dos Claude. Sem rede e sem banco.
 *   executar   — C e F5: cada conversa do corpus vira um turno REAL do motor em
 *                modo prévia (`runAgentPreview`, o caminho do "Testar"), no banco
 *                LOCAL, com o knob do braço no ambiente do processo. GASTA TOKENS.
 *   julgar     — F5: o juiz par a par (json × linhas), direto no provedor. GASTA.
 *   corpus-g   — escreve o corpus do G no formato de scripts/avaliar-fechamento.ts.
 *   relatorio  — lê os resultados e imprime o veredito. Sem rede e sem banco.
 *
 * Uso (sempre com o .env.local do ambiente fresco local):
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts plano --avaliacao C --precos precos.json
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts executar --avaliacao C --braco off \
 *     --modelo anthropic:claude-sonnet-5 --agentes clinica=<id>,loja=<id>,imobiliaria=<id>,curso=<id> \
 *     --k 3 --saida c.jsonl --precos precos.json --teto-usd 20 [--conversas C01,C02]
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts julgar --entrada f5.jsonl --saida juizo.jsonl \
 *     --precos precos.json --teto-usd 5
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts corpus-g --saida corpus-g.json
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts relatorio --avaliacao C --entrada c.jsonl
 *
 * `executar` só fala com banco LOCAL: o `.env.local` de um checkout de trabalho
 * aponta para produção, e esta avaliação nunca roda lá.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { generateText } from "ai";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type pg from "pg";
import { z } from "zod";

import type { AvaliacaoDaConversa } from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";

import {
  BRACOS,
  custoDoLote,
  custoDosTokens,
  idNaOpenRouter,
  indicadores,
  jsonPrimeiro,
  juizoDaResposta,
  knobsDoBraco,
  MEDIDO,
  nosComPadraoEFormato,
  pedidoDoJuiz,
  precoDaOpenRouter,
  promptDoJuiz,
  provaDoBraco,
  tokensDoUso,
  validarChamada,
  contarAterro,
  vereditoC,
  vereditoF5,
  vereditoG,
  type AvaliacaoDoTurno,
  type ChamadaGravada,
  type ChamadaPrevista,
  type EsquemaDeReferencia,
  type Execucao,
  type Juizo,
  type Preco,
  type Sonda,
  type Veredito,
} from "./lib/avaliacao-de-tokens";
import {
  AGORA,
  checkpointAnterior,
  contextoDaConversa,
  corpusDa,
  PERSONAS,
  transcricao,
  type Conversa,
  type PersonaId,
} from "./lib/corpus-de-avaliacao";
import type { ProviderRegistry } from "@/lib/agent-engine/edge/llm/providers";

import { destinoEhLocal } from "./lib/env-de-teste";
import { modeloDireto } from "./lib/fabricas-diretas";

/** Os quatro modelos medidos em out/2026 e o econômico de cada provedor (o mais barato do catálogo). */
const MODELOS_EM_USO = ["openai:gpt-5.6-luna", "openai:gpt-5.6-terra", "anthropic:claude-sonnet-4-6", "anthropic:claude-sonnet-5"];
const ECONOMICO: Readonly<Record<string, string>> = { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };
/** K padrão: C repete cada conversa 3× por braço (o desenho); F5 e G uma vez (G roda o corpus 2×: ver plano). */
const K_PADRAO: Readonly<Record<string, number>> = { C: 3, F5: 1, G: 2 };

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function exigir(nome: string): string {
  const v = arg(nome);
  if (v === undefined || v === "") throw new Error(`--${nome} é obrigatório`);
  return v;
}

function escrever(linha = ""): void {
  process.stdout.write(`${linha}\n`);
}

function avaliacaoPedida(): "C" | "F5" | "G" {
  const a = exigir("avaliacao");
  if (a !== "C" && a !== "F5" && a !== "G") throw new Error("--avaliacao C|F5|G");
  return a;
}

function modeloPedido(texto: string): { provedor: string; modelo: string } {
  const i = texto.indexOf(":");
  if (i <= 0) throw new Error(`modelo no formato provedor:modelo (ex.: anthropic:claude-sonnet-5), veio ${texto}`);
  return { provedor: texto.slice(0, i), modelo: texto.slice(i + 1) };
}

function precos(): unknown {
  return JSON.parse(readFileSync(exigir("precos"), "utf8"));
}

const ehClaude = (provedor: string, modelo: string) => provedor === "anthropic" || modelo.startsWith("anthropic/");

function linhasJsonl<T>(arquivos: string): T[] {
  return arquivos
    .split(",")
    .flatMap((a) => readFileSync(a.trim(), "utf8").split("\n"))
    .filter((l) => l.trim() !== "")
    .map((l): T => JSON.parse(l));
}

// ═══ plano ═════════════════════════════════════════════════════════════════════

interface LinhaDoPlano {
  avaliacao: string;
  modelo: string;
  braco: string;
  execucoes: number;
  chamadas: ChamadaPrevista[];
  segundos: number;
  fator: number;
  preco: Preco;
}

async function chamadasDoTurno(conversas: readonly Conversa[], k: number, braco: string, avaliacao: AvaliacaoDoTurno): Promise<ChamadaPrevista[]> {
  const { CHECKPOINT_INSTRUCTION } = await import("@/lib/agent-engine/agent/abertura/checkpoint");
  const { abertura: abrir, pesoDasFerramentas } = await import("./lib/pedidos-de-avaliacao");
  const knobs = knobsDoBraco(avaliacao, braco);
  const formato = knobs.LEAD_CONTEXT_HISTORY_FORMAT === "linhas" ? "linhas" : "json";
  const semPadrao = knobs.LLM_TOOL_SCHEMA_SEM_PADRAO === "on";
  const pesos = new Map<PersonaId, number>();
  const chamadas: ChamadaPrevista[] = [];
  for (const c of conversas) {
    const ferramentas = pesos.get(c.persona) ?? (await pesoDasFerramentas(c.persona, semPadrao));
    pesos.set(c.persona, ferramentas);
    const sistema = MEDIDO.sistemaDoMotor + countTokens(PERSONAS[c.persona].prompt);
    const abertura = countTokens(abrir(c, formato));
    for (let i = 0; i < k; i++) {
      for (let s = 0; s < MEDIDO.passosPorTurno; s++)
        chamadas.push({ prefixo: ferramentas + sistema, chavePrefixo: `turno:${c.persona}`, resto: abertura + s * MEDIDO.crescimentoPorPasso, saida: MEDIDO.saidaPorPasso });
      chamadas.push({
        prefixo: sistema,
        chavePrefixo: `fechamento:${c.persona}`,
        resto: abertura + MEDIDO.passosPorTurno * MEDIDO.crescimentoPorPasso + countTokens(CHECKPOINT_INSTRUCTION),
        saida: MEDIDO.saidaDoFechamento,
      });
      chamadas.push({ prefixo: 0, chavePrefixo: "", resto: MEDIDO.promessaSemantica.entrada, saida: MEDIDO.promessaSemantica.saida });
    }
  }
  return chamadas;
}

async function plano(): Promise<void> {
  const avaliacao = avaliacaoPedida();
  const catalogo = precos();
  const k = Number(arg("k") ?? K_PADRAO[avaliacao]);
  const modelos = (arg("modelos")?.split(",") ?? MODELOS_EM_USO).map((m) => m.trim());
  const conversas = corpusDa(avaliacao);
  const linhas: LinhaDoPlano[] = [];
  for (const m of modelos) {
    const { provedor, modelo } = modeloPedido(m);
    const preco = precoDaOpenRouter(catalogo, idNaOpenRouter(provedor, modelo));
    const fator = ehClaude(provedor, modelo) ? MEDIDO.fatorClaude : 1;
    if (avaliacao === "G") {
      const { pedidosDoFechamento } = await import("./lib/pedidos-de-avaliacao");
      const pedidos = pedidosDoFechamento(conversas);
      const { CHECKPOINT_INSTRUCTION } = await import("@/lib/agent-engine/agent/abertura/checkpoint");
      const fechamento = (p: (typeof pedidos)[number]): ChamadaPrevista => ({
        // Sem prefixo cacheável: o roteiro não marca cache, e o `system` de cada
        // agente fica abaixo do mínimo cacheável (1.024 tokens) de qualquer jeito.
        prefixo: 0,
        chavePrefixo: "",
        resto: countTokens(p.system) + p.mensagens.reduce((s, x) => s + countTokens(x.content), 0) + countTokens(CHECKPOINT_INSTRUCTION),
        saida: MEDIDO.saidaDoFechamento,
      });
      const umaRodada = pedidos.map(fechamento);
      const vezes = <T,>(xs: T[], n: number) => Array.from({ length: n }, () => xs).flat();
      const economico = ECONOMICO[provedor];
      if (economico === undefined) throw new Error(`sem modelo econômico conhecido para ${provedor}`);
      for (const [braco, preco_] of [["atual", preco], ["controle", preco]] as const)
        linhas.push({ avaliacao, modelo: m, braco, execucoes: pedidos.length * k, chamadas: vezes(umaRodada, k), segundos: pedidos.length * k * MEDIDO.segundosPorFechamento, fator, preco: preco_ });
      const precoEconomico = precoDaOpenRouter(catalogo, idNaOpenRouter(provedor, economico));
      const comCorrecao = Math.ceil(pedidos.length * k * (1 + MEDIDO.correcaoDaSombra));
      linhas.push({
        avaliacao,
        modelo: m,
        braco: `sombra (${economico})`,
        execucoes: pedidos.length * k,
        chamadas: vezes(umaRodada, Math.ceil(k * (1 + MEDIDO.correcaoDaSombra))).slice(0, comCorrecao),
        segundos: comCorrecao * MEDIDO.segundosPorFechamento,
        fator,
        preco: precoEconomico,
      });
      continue;
    }
    for (const braco of BRACOS[avaliacao]) {
      const chamadas = await chamadasDoTurno(conversas, k, braco, avaliacao);
      linhas.push({ avaliacao, modelo: m, braco, execucoes: conversas.length * k, chamadas, segundos: conversas.length * k * MEDIDO.segundosPorTurno, fator, preco });
    }
    if (avaliacao === "F5") {
      const juiz = conversas.map((c): ChamadaPrevista => {
        const resposta = c.resposta.join("\n");
        return { prefixo: 0, chavePrefixo: "", resto: countTokens(promptDoJuiz(transcricao(c), resposta, resposta)), saida: MEDIDO.saidaDoJuiz };
      });
      linhas.push({ avaliacao, modelo: m, braco: "juiz", execucoes: juiz.length, chamadas: juiz, segundos: juiz.length * MEDIDO.segundosPorJuiz, fator, preco });
    }
  }
  escrever(`# avaliação ${avaliacao}: ${conversas.length} conversas, K=${k}, modelos ${modelos.join(", ")}`);
  escrever(["modelo", "braço", "execuções", "chamadas", "entrada (Mtok)", "saída (ktok)", "US$ cache on", "US$ cache off", "horas"].join("\t"));
  let on = 0;
  let off = 0;
  let segundos = 0;
  for (const l of linhas) {
    const entrada = l.chamadas.reduce((s, c) => s + (c.prefixo + c.resto) * l.fator, 0);
    const saida = l.chamadas.reduce((s, c) => s + c.saida, 0);
    // OpenAI: o cache é automático e não desliga — "off" só existe para os Claude.
    const usdOn = custoDoLote(l.chamadas, l.preco, true, l.fator);
    const usdOff = l.fator === 1 ? usdOn : custoDoLote(l.chamadas, l.preco, false, l.fator);
    on += usdOn;
    off += usdOff;
    segundos += l.segundos;
    escrever([l.modelo, l.braco, l.execucoes, l.chamadas.length, (entrada / 1e6).toFixed(2), (saida / 1e3).toFixed(1), usdOn.toFixed(2), usdOff.toFixed(2), (l.segundos / 3600).toFixed(1)].join("\t"));
  }
  escrever(["TOTAL", "", "", "", "", "", on.toFixed(2), off.toFixed(2), (segundos / 3600).toFixed(1)].join("\t"));
}

// ═══ executar ══════════════════════════════════════════════════════════════════

function exigirBancoLocal(): void {
  for (const nome of ["SUPABASE_DB_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    const alvo = process.env[nome] ?? "";
    if (alvo === "" || !destinoEhLocal(alvo)) throw new Error(`${nome} não é local (${alvo === "" ? "vazio" : "remoto"}) — a avaliação só roda no ambiente fresco local`);
  }
}

const ehPersona = (p: string): p is PersonaId => Object.hasOwn(PERSONAS, p);

function agentesPedidos(): Map<PersonaId, string> {
  const m = new Map<PersonaId, string>();
  for (const par of exigir("agentes").split(",")) {
    const [persona, id] = par.split("=").map((s) => s.trim());
    if (persona === undefined || id === undefined || !ehPersona(persona)) throw new Error(`--agentes persona=<agent_id>; persona é ${Object.keys(PERSONAS).join("|")}, veio ${par}`);
    m.set(persona, id);
  }
  return m;
}

/**
 * O que o modelo pediu e recebeu em cada chamada, gravado no SEAM do provedor:
 * é ali que se vê a chamada de ferramenta ANTES da validação do AI SDK (que
 * descarta a entrada inválida sem passar pelo `execute`, e por isso o traço do
 * turno nunca a vê). Só `doGenerate`: o provedor por assinatura usa streaming e
 * fica fora da avaliação, com erro, em vez de passar sem medida.
 */
// Leitura tolerante do que o provedor recebeu e devolveu (o formato é do AI SDK, V3 ou V4).
const campo = (v: unknown, k: string): unknown => (v !== null && typeof v === "object" ? Reflect.get(v, k) : undefined);
const lista = (v: unknown, k: string): unknown[] => {
  const x = campo(v, k);
  return Array.isArray(x) ? x : [];
};
const texto = (v: unknown, k: string): string => {
  const x = campo(v, k);
  return typeof x === "string" ? x : "";
};

function registryQueGrava(
  base: ProviderRegistry,
  destino: ChamadaGravada[],
  esquemaDe: (nome: string) => EsquemaDeReferencia | null,
  ehAterro: (v: unknown) => boolean,
  preco: Preco,
): ProviderRegistry {
  const gravar = (opcoes: unknown, resposta: unknown) => {
    const ferramentas = lista(opcoes, "tools");
    const nomes = new Set(ferramentas.map((t) => texto(t, "name")));
    const temFormato = new Map(ferramentas.map((t) => [texto(t, "name"), JSON.stringify(campo(t, "inputSchema") ?? {}).includes('"format"')]));
    const tokens = tokensDoUso(campo(resposta, "usage"));
    destino.push({
      comFerramentas: ferramentas.length > 0,
      padraoComFormato: ferramentas.reduce((s: number, t) => s + nosComPadraoEFormato(campo(t, "inputSchema")), 0),
      ferramentas: lista(resposta, "content")
        .filter((p) => texto(p, "type") === "tool-call")
        .map((p) => ({
          nome: texto(p, "toolName"),
          validade: validarChamada(texto(p, "toolName"), texto(p, "input"), nomes, esquemaDe),
          temFormato: temFormato.get(texto(p, "toolName")) ?? false,
          aterro: contarAterro(texto(p, "input"), ehAterro),
        })),
      tokens,
      custoUsd: custoDosTokens(tokens, preco),
    });
  };
  return Object.fromEntries(
    Object.entries(base).map(([nome, fabrica]) => [
      nome,
      (...args: Parameters<typeof fabrica>) => {
        const modelo = fabrica(...args);
        if (modelo === null || typeof modelo !== "object") return modelo;
        return new Proxy(modelo, {
          get(alvo, prop) {
            const v: unknown = Reflect.get(alvo, prop);
            if (prop === "doStream")
              return () => {
                throw new Error("a avaliação grava só doGenerate; o provedor por assinatura (streaming) não serve");
              };
            if (prop === "doGenerate" && typeof v === "function")
              return async (opcoes: unknown) => {
                const resposta: unknown = await v.call(alvo, opcoes);
                gravar(opcoes, resposta);
                return resposta;
              };
            return typeof v === "function" ? v.bind(alvo) : v;
          },
        });
      },
    ]),
  );
}

async function executar(): Promise<void> {
  const avaliacao = avaliacaoPedida();
  if (avaliacao === "G") throw new Error("o G roda por scripts/avaliar-fechamento.ts (ver corpus-g e o runbook)");
  const braco = exigir("braco");
  // O knob ANTES de qualquer import do motor: `loadEnv` lê o ambiente uma vez.
  const knobs = knobsDoBraco(avaliacao, braco);
  Object.assign(process.env, knobs);
  exigirBancoLocal();
  const { provedor, modelo } = modeloPedido(exigir("modelo"));
  const preco = precoDaOpenRouter(precos(), idNaOpenRouter(provedor, modelo));
  const teto = Number(exigir("teto-usd"));
  if (!(teto > 0)) throw new Error("--teto-usd precisa ser positivo");
  const saida = exigir("saida");
  const k = Number(arg("k") ?? K_PADRAO[avaliacao]);
  const agentes = agentesPedidos();
  const filtro = arg("conversas")?.split(",").map((s) => s.trim());
  const conversas = corpusDa(avaliacao).filter((c) => agentes.has(c.persona) && (filtro === undefined || filtro.includes(c.id)));
  if (conversas.length === 0) throw new Error("nenhuma conversa do corpus para os agentes/conversas pedidos");

  const { requestTurnDeps } = await import("@/lib/agent-engine/agent/request-deps");
  const { runAgentPreview, AGENT_TOOL_DEFS } = await import("@/lib/agent-engine/agent/inbound-turn");
  const { loadAgentVersionConfig } = await import("@/lib/agent-engine/agent/agent-config");
  const { newPreviewResult } = await import("@/lib/agent-engine/agent/preview");
  const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const { getToolByName } = await import("@/lib/mcp/tools");
  const { ehUuidDeAterro } = await import("@/lib/mcp/uuid-de-aterro");

  const deps = requestTurnDeps();
  // O braço se prova no boot (o ambiente chegou) e no fio de cada execução (provaDoBraco).
  const formato = deps.knobs.historyFormat ?? "json";
  if ((deps.llmCfg.esquemaSemPadrao === true) !== (knobs.LLM_TOOL_SCHEMA_SEM_PADRAO === "on") || formato !== knobs.LEAD_CONTEXT_HISTORY_FORMAT)
    throw new Error(`o motor leu esquemaSemPadrao=${String(deps.llmCfg.esquemaSemPadrao)} e formato=${formato}; o braço ${braco} pede ${JSON.stringify(knobs)}`);
  const nativas: ReadonlyMap<string, EsquemaDeReferencia> = new Map(Object.entries(AGENT_TOOL_DEFS).map(([n, d]) => [n, d.inputSchema]));
  const esquemaDe = (nome: string): EsquemaDeReferencia | null => {
    const nativa = nativas.get(nome);
    if (nativa !== undefined) return nativa;
    const t = getToolByName(nome);
    // A régua do servidor: o shape do catálogo como objeto zod (nenhuma ferramenta compilada tem shape vazio).
    return t === undefined ? null : z.object(t.inputSchema);
  };
  const pool: pg.Pool = getRequestPool();
  const agentesCarregados = new Map<PersonaId, { organizationId: string; config: NonNullable<Awaited<ReturnType<typeof loadAgentVersionConfig>>> }>();
  for (const [persona, agentId] of agentes) {
    const { rows } = await pool.query<{ organization_id: string; published_version_id: string | null }>(
      "select organization_id, published_version_id from ai_agents where id = $1",
      [agentId],
    );
    const a = rows[0];
    if (a === undefined || a.published_version_id === null) throw new Error(`agente ${agentId} (${persona}) não existe ou não tem versão publicada`);
    const config = await loadAgentVersionConfig(pool, a.organization_id, agentId, a.published_version_id);
    if (config === null) throw new Error(`versão publicada do agente ${persona} indisponível`);
    const faltam = PERSONAS[persona].ferramentas.filter((t) => !config.toolIds.includes(t));
    if (faltam.length > 0) throw new Error(`o agente ${persona} não tem as capacidades do preparo: ${faltam.join(", ")}`);
    const { rows: cred } = await pool.query<{ id: string }>(
      "select id from ai_provider_credentials where organization_id = $1 and provider = $2 and is_active order by created_at desc limit 1",
      [a.organization_id, provedor],
    );
    if (cred[0] === undefined) throw new Error(`cadastre na tela uma credencial ativa do provedor ${provedor} na organização do agente ${persona}`);
    // O modelo do lote entra por aqui, e não republicando: o resto da versão (prompt, capacidades) fica como está.
    agentesCarregados.set(persona, { organizationId: a.organization_id, config: { ...config, provider: provedor, model: modelo, credentialId: cred[0].id } });
  }

  let gasto = 0;
  try {
    for (let i = 1; i <= k; i++) {
      for (const c of conversas) {
        const agente = agentesCarregados.get(c.persona);
        if (agente === undefined) continue;
        const chamadas: ChamadaGravada[] = [];
        const registry = registryQueGrava(createDefaultRegistry({ deepseekThinking: deps.llmCfg.deepseekThinking }), chamadas, esquemaDe, ehUuidDeAterro, preco);
        const result = newPreviewResult();
        let erro: string | null = null;
        try {
          await runAgentPreview({ ...deps, registry, clock: () => new Date(AGORA) }, pool, {
            kind: "sandbox",
            organizationId: agente.organizationId,
            runId: randomUUID(),
            agent: agente.config,
            context: contextoDaConversa(c),
            previous: checkpointAnterior(c),
            contactId: null,
            channelId: null,
            result,
          });
        } catch (e) {
          erro = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
        const execucao: Execucao = {
          avaliacao,
          braco,
          modelo: `${provedor}:${modelo}`,
          conversa: c.id,
          k: i,
          chamadas,
          candidatos: result.candidates.map((x) => x.body),
          vetos: [...result.impediments, ...result.warnings].map((x) => x.code).filter((codigo) => codigo !== "midia_sem_fotos"),
          erro,
          checkpoint: result.checkpoint,
          propostas: result.proposals,
        };
        const prova = erro === null ? provaDoBraco(execucao) : null;
        if (prova !== null) execucao.erro = `prova do braço: ${prova}`;
        appendFileSync(saida, `${JSON.stringify(execucao)}\n`);
        const custo = chamadas.reduce((s, x) => s + x.custoUsd, 0);
        gasto += custo;
        const ind = indicadores(execucao);
        escrever(`${c.id}\tk=${i}\t${braco}\tpassos ${ind.passos}\tferramentas ${ind.chamadas}\tinválidas ${ind.invalidas}\tUS$ ${custo.toFixed(4)}\ttotal US$ ${gasto.toFixed(2)}${execucao.erro !== null ? `\tERRO ${execucao.erro}` : ""}`);
        // Braço que não se provou no fio não mede o que diz: o lote para.
        if (prova !== null) throw new Error(`${c.id}: ${prova}`);
        if (gasto >= teto) {
          escrever(`# teto de US$ ${teto} atingido (US$ ${gasto.toFixed(2)}): o lote para aqui, e o que foi medido está em ${saida}`);
          process.exitCode = 3;
          return;
        }
      }
    }
  } finally {
    await pool.end();
  }
}

// ═══ julgar (F5) ═══════════════════════════════════════════════════════════════

async function julgar(): Promise<void> {
  const execucoes = linhasJsonl<Execucao>(exigir("entrada")).filter((e) => e.avaliacao === "F5" && e.erro === null);
  const saida = exigir("saida");
  const teto = Number(exigir("teto-usd"));
  if (!(teto > 0)) throw new Error("--teto-usd precisa ser positivo");
  const catalogo = precos();
  const corpus = new Map(corpusDa("F5").map((c) => [c.id, c]));
  let gasto = 0;
  for (const modeloTexto of [...new Set(execucoes.map((e) => e.modelo))]) {
    const { provedor, modelo } = modeloPedido(modeloTexto);
    const preco = precoDaOpenRouter(catalogo, idNaOpenRouter(provedor, modelo));
    const lm = modeloDireto(provedor, modelo);
    const doModelo = execucoes.filter((e) => e.modelo === modeloTexto);
    for (const c of corpus.values()) {
      const json = doModelo.find((e) => e.conversa === c.id && e.braco === "json");
      const linhas = doModelo.find((e) => e.conversa === c.id && e.braco === "linhas");
      if (json === undefined || linhas === undefined) continue;
      const jsonFoiA = jsonPrimeiro(c.id);
      const [a, b] = jsonFoiA ? [json, linhas] : [linhas, json];
      const r = await generateText({
        model: lm,
        ...pedidoDoJuiz(transcricao(c), a.candidatos.join("\n"), b.candidatos.join("\n")),
      });
      const custo = custoDosTokens(tokensDoUso(r.usage), preco);
      gasto += custo;
      const juizo: Juizo = {
        modelo: modeloTexto,
        conversa: c.id,
        ...juizoDaResposta({ text: r.text, finishReason: r.finishReason, outputTokens: r.usage.outputTokens }, jsonFoiA),
        custoUsd: custo,
      };
      appendFileSync(saida, `${JSON.stringify(juizo)}\n`);
      escrever(
        `${modeloTexto}\t${c.id}\t${juizo.voto}${juizo.motivo ? ` (${juizo.motivo})` : ""}\tsaída ${juizo.tokensDeSaida ?? "?"} tokens\tUS$ ${gasto.toFixed(2)}`,
      );
      if (gasto >= teto) {
        escrever(`# teto de US$ ${teto} atingido: o juiz para aqui`);
        process.exitCode = 3;
        return;
      }
    }
  }
}

// ═══ corpus-g ══════════════════════════════════════════════════════════════════

async function corpusG(): Promise<void> {
  const saida = exigir("saida");
  const { pedidosDoFechamento } = await import("./lib/pedidos-de-avaliacao");
  const pedidos = pedidosDoFechamento(corpusDa("G"));
  writeFileSync(saida, JSON.stringify(pedidos, null, 2));
  escrever(`${pedidos.length} conversas em ${saida} (${pedidos.filter((p) => p.anterior !== null).length} com resumo anterior)`);
}

// ═══ relatorio ═════════════════════════════════════════════════════════════════

function imprimir(v: Veredito, gasto?: number): void {
  escrever(`${v.modelo}: ${v.resultado.toUpperCase()}${gasto !== undefined ? ` — gasto medido US$ ${gasto.toFixed(2)}` : ""}`);
  for (const l of v.linhas) escrever(`  ${l}`);
  for (const m of v.motivos) escrever(`  → ${m}`);
}

async function relatorio(): Promise<void> {
  const avaliacao = avaliacaoPedida();
  if (avaliacao === "G") {
    const arquivos = exigir("entrada").split(",").map((a) => a.trim());
    const porModelo = new Map<string, AvaliacaoDaConversa[]>();
    for (const a of arquivos) {
      const r: { agente: string; economico: string; conversas: AvaliacaoDaConversa[]; interrompido?: string | null } = JSON.parse(readFileSync(a, "utf8"));
      if (r.interrompido) escrever(`# ${a}: interrompido — ${r.interrompido}`);
      const chave = `${r.agente} → ${r.economico}`;
      porModelo.set(chave, [...(porModelo.get(chave) ?? []), ...r.conversas]);
    }
    for (const [chave, conversas] of porModelo) imprimir({ ...vereditoG(conversas), modelo: chave });
    return;
  }
  const execucoes = linhasJsonl<Execucao>(exigir("entrada")).filter((e) => e.avaliacao === avaliacao);
  const comErro = execucoes.filter((e) => e.erro !== null);
  if (comErro.length > 0) escrever(`# ${comErro.length} execução(ões) com erro ficam fora do veredito: ${comErro.slice(0, 5).map((e) => `${e.conversa}/${e.braco}/k${e.k}: ${e.erro}`).join(" · ")}`);
  const juizos = arg("juizo") === undefined ? [] : linhasJsonl<Juizo>(exigir("juizo"));
  const sondas = new Map<string, Sonda>(corpusDa("F5").flatMap((c) => (c.sonda === undefined ? [] : [[c.id, c.sonda] as const])));
  for (const modelo of [...new Set(execucoes.map((e) => e.modelo))]) {
    const gasto = execucoes.filter((e) => e.modelo === modelo).reduce((s, e) => s + e.chamadas.reduce((t, c) => t + c.custoUsd, 0), 0) +
      juizos.filter((j) => j.modelo === modelo).reduce((s, j) => s + j.custoUsd, 0);
    const n = execucoes.filter((e) => e.modelo === modelo).length;
    imprimir(avaliacao === "C" ? vereditoC(execucoes, modelo) : vereditoF5(execucoes, juizos, sondas, modelo), gasto);
    escrever(`  ${n} execuções, US$ ${(gasto / Math.max(1, n)).toFixed(4)} por execução (régua para projetar o lote inteiro)`);
  }
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  if (comando === "plano") return plano();
  if (comando === "executar") return executar();
  if (comando === "julgar") return julgar();
  if (comando === "corpus-g") return corpusG();
  if (comando === "relatorio") return relatorio();
  throw new Error("comando: plano | executar | julgar | corpus-g | relatorio");
}

main().catch((err: unknown) => {
  process.stderr.write(`[avaliar-tokens] falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
