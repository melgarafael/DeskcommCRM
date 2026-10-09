/**
 * A CONFERÊNCIA DE CAMPO PERSONALIZADO DO NEGÓCIO (#2234) — a IA só grava o
 * que o CLIENTE disse.
 *
 * `crm_update_lead` grava `custom_fields` direto desde a #421, sem nenhuma
 * conferência entre o valor e a conversa: "procuro algo pequeno pra mim e meu
 * cachorro" virava `quartos: 1`, e "moro na Asa Norte mas quero sair daqui"
 * virava `bairro: "Asa Norte"`. Os campos de CONTATO já passam por proposta com
 * confirmação humana (#1650); os do negócio não, e confirmar cada valor com uma
 * pessoa seria pesada demais no volume de um funil ativo.
 *
 * ═══ DOIS DEGRAUS ═══
 *
 *  1. **Código, sem rede** (`degrauUmCobre` + `valorDitoLiteralmente`): número,
 *     data, e-mail e valor monetário são normalizados — "2 mil", "2.000" e
 *     `2000` são o MESMO número — e comparados com o que o cliente escreveu.
 *     Dito literalmente, grava sem perguntar a ninguém. É o degrau que cobre a
 *     maioria dos casos e não gasta chamada nenhuma.
 *  2. **O Jev** (`./tarefas.ts`, `campo_do_negocio`), só no que sobrou: UMA
 *     chamada com as perguntas de TODOS os campos da chamada — `dito_<campo>` e
 *     `contrario_<campo>` por campo. `dito > 0,7` e `contrario < 0,3` gravam;
 *     o resto não grava e devolve ao modelo um ERRO DE ENSINO ("o cliente não
 *     disse quartos; se precisar, pergunte"), com os outros campos da mesma
 *     chamada seguindo gravando.
 *
 * ═══ NASCE DESLIGADA, E FALHA ABERTO ═══
 *
 * A tarefa tem alcance "conversa": sem o aceite da conversa e sem alguém
 * escolher um estado para ela, nasce DESLIGADA (`estadoEfetivoDaTarefa`), e a
 * ficha grava como antes. Observando (ou com a tarefa desligada, sem credencial
 * ou com o fornecedor fora) o campo é GRAVADO, como hoje — é ficha, não envio ao cliente, e perder
 * dado é pior que gravar dedução; o que a observação registra é o par
 * `rotulo_jev` × `rotulo_atual` em `jev_observacoes`, SÓ com rótulos: nem o
 * valor do campo nem o texto do cliente saem daqui (o texto que vai para o Jev
 * passa antes pelo `scrubMessage`, e a linha gravada nem o texto nem o valor
 * carregam). Toda chamada vira linha em `llm_calls` — a que deu certo com o
 * custo, para aparecer em Uso de IA; a que falhou com `error_code` (`jev_*`).
 *
 * Nunca lança: quem chama recebe `{ gravaveis, recusados }` e decide.
 */
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import { MODELO_DO_JEV, type FalhaDaDecisao, type Pergunta, type Resposta } from "./cliente";
import type { ConfigDoJev, EstadoQuePergunta } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { chaveDasTarefas, decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import { codigoDoErroDoJev } from "./textos";
import {
  CONFERENCIA_DE_CAMPO,
  estadoEfetivoDaTarefa,
  TAREFA_DA_CONFERENCIA_DE_CAMPO,
} from "./tarefas";

type Admin = ReturnType<typeof createAdminClient>;

/** Acima disso, o Jev diz que o cliente DISSE o valor. `>` — igual não passa. */
export const LIMIAR_DITO = 0.7;
/** Abaixo disso, o Jev não vê o cliente RECUSANDO o valor. `<` — igual não passa. */
export const LIMIAR_CONTRARIO = 0.3;

/** Um campo personalizado do funil que a IA quer gravar. */
export interface CampoPersonalizado {
  /** A chave em `custom_fields` — a que o modelo escreveu. */
  chave: string;
  /** O rótulo que o dono deu ao campo no funil; sem leitura, a própria chave. */
  nome: string;
  valor: unknown;
}

export type MotivoDaRecusa = "cliente_nao_disse" | "cliente_disse_o_contrario";

export interface CampoRecusado {
  campo: string;
  motivo: MotivoDaRecusa;
  /** O erro de ensino que vai de volta ao MODELO — nunca o texto do cliente. */
  mensagem: string;
}

export interface ConferenciaDosCampos {
  /**
   * As chaves que seguem gravando: todas, exceto em `decidindo`, onde saem as
   * que o Jev não confirmou (essas vão para `recusados`).
   */
  gravaveis: string[];
  recusados: CampoRecusado[];
  /** O estado efetivo da tarefa quando a conferência rodou. */
  estado: EstadoQuePergunta | "desligada" | "sem_conversa";
  /** Se o degrau 2 foi chamado, e com quê a chamada terminou. */
  error_code?: string;
}

// ── Degrau 1: código, sem rede ──────────────────────────────────────────────

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Números do texto, na régua do cliente: "2 mil" = 2000, "2.000,50" = 2000.5,
 * "2 quartos" = 2. Dois formatos de milhar convivem no Brasil — o ponto de
 * milhar (`R$ 2.000,00`) sai ANTES de procurar o decimal com vírgula, senão o
 * "2.000,50" viraria os dois números `2000` e `50`.
 */
export function extrairNumeros(texto: string): number[] {
  const saida: number[] = [];
  for (const bruto of texto.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?/g) ?? []) {
    const n = Number(bruto.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) saida.push(n);
  }
  const resto = texto.replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?/g, " ");
  for (const bruto of resto.match(/\d+(?:[.,]\d+)?\s*(?:mil|milhar|milhares)?/gi) ?? []) {
    const m = /^(\d+(?:[.,]\d+)?)\s*(mil|milhar|milhares)?$/i.exec(bruto.trim());
    if (!m) continue;
    const n = Number((m[1] ?? "").replace(",", "."));
    if (!Number.isFinite(n)) continue;
    saida.push(m[2] !== undefined ? n * 1000 : n);
  }
  return saida;
}

/** O valor como número, quando ele É número, dinheiro ou data? `null` se não. */
export function numeroDoValor(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== "string") return null;
  const t = valor.trim();
  if (!/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$|^-?\d+(?:[.,]\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * O degrau 1 cobre ESTE valor? Só número, data, e-mail e valor monetário, como
 * manda a proposta da issue — texto livre (`bairro`, `tipo_imovel`) não tem
 * normalização segura e vai para o degrau 2.
 */
export function degrauUmCobre(valor: unknown): boolean {
  if (typeof valor === "number") return true;
  if (typeof valor !== "string") return false;
  const t = valor.trim();
  return RE_EMAIL.test(t) || RE_DATA.test(t) || numeroDoValor(t) !== null;
}

/** O valor aparece LITERALMENTE (normalizado) em alguma mensagem do cliente? */
export function valorDitoLiteralmente(valor: unknown, mensagens: readonly string[]): boolean {
  const juntas = mensagens.join("\n");
  if (juntas.trim() === "") return false;
  if (typeof valor === "number") {
    return extrairNumeros(juntas).some((n) => Math.abs(n - valor) < 1e-9);
  }
  if (typeof valor !== "string") return false;
  const t = valor.trim();
  if (RE_EMAIL.test(t)) return juntas.toLowerCase().includes(t.toLowerCase());
  if (RE_DATA.test(t)) {
    const [ano, mes, dia] = t.split("-");
    if (juntas.includes(t)) return true;
    if (!ano || !mes || !dia) return false;
    // O ANO tem de estar junto: "05/10" sozinho casa com 05/10/1990 e seria
    // "dito" uma data que o cliente não disse.
    return juntas.includes(`${dia}/${mes}/${ano}`) || juntas.includes(`${Number(dia)}/${Number(mes)}/${ano}`);
  }
  const n = numeroDoValor(t);
  if (n === null) return false;
  return extrairNumeros(juntas).some((x) => Math.abs(x - n) < 1e-9);
}

// ── Degrau 2: as perguntas por campo ────────────────────────────────────────

/** O texto do valor como ele vai na pergunta. */
function textoDoValor(valor: unknown): string {
  if (typeof valor === "string") return valor.trim();
  if (valor === null || valor === undefined) return "(vazio)";
  return String(valor);
}

/** `dito_quartos`, `contrario_bairro` — estável e sem caractere estranho. */
export function idDaPergunta(chave: string, tipo: "dito" | "contrario", sufixo = ""): string {
  const slug =
    chave
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "campo";
  return `${tipo}_${slug}${sufixo}`;
}

/** As duas perguntas de um campo (`k`), no molde da issue. */
export function perguntasDoCampo(nome: string, valor: unknown, ids: { dito: string; contrario: string }): Record<string, Pergunta> {
  const alvo = textoDoValor(valor);
  return {
    [ids.dito]: {
      tipo: "noul",
      instrucao: `O cliente informou, nas mensagens dele ainda sem resposta neste turno, que ${nome} é ${alvo} — em qualquer redação ou formato?`,
      criterios: {
        true: "O cliente mesmo escreveu esse valor (número, data, e-mail, dinheiro ou palavra), em qualquer formato ou paráfrase.",
        false: "O valor não está no que ele escreveu, ou só a IA deduziu a partir de outra coisa.",
      },
    },
    [ids.contrario]: {
      tipo: "noul",
      instrucao: `Nas mesmas mensagens, o cliente disse que NÃO quer ou NÃO é ${alvo} para ${nome}?`,
      criterios: {
        true: "Ele diz que não quer, quer mudar, quer sair disso, ou que o valor não é esse.",
        false: "Nada ali recusa ou contradiz esse valor.",
      },
    },
  };
}

/** A probabilidade de "sim" de uma pergunta noul, ou `null` se não for uma. */
function probabilidade(resposta: Resposta | undefined): number | null {
  if (resposta?.tipo !== "noul") return null;
  return Number.isFinite(resposta.noul) && resposta.noul >= 0 && resposta.noul <= 1 ? resposta.noul : null;
}

/** O veredito do degrau 2, ao pé da letra da issue. */
export function gravaPeloJev(dito: number, contrario: number): boolean {
  return dito > LIMIAR_DITO && contrario < LIMIAR_CONTRARIO;
}

/** O erro de ensino que o modelo recebe no lugar do campo. */
function ensino(nome: string, valor: unknown, motivo: MotivoDaRecusa): string {
  if (motivo === "cliente_disse_o_contrario") {
    return `As mensagens deste turno dizem o contrário de ${nome} = ${textoDoValor(valor)}: não grave — pergunte ao cliente qual é o valor certo.`;
  }
  return `O cliente não disse ${nome} = ${textoDoValor(valor)} nas mensagens deste turno; não grave por conta própria — se precisar deste dado, pergunte a ele.`;
}

// ── A chamada ───────────────────────────────────────────────────────────────

export interface EntradaDaConferencia {
  organizationId: string;
  conversationId: string | null;
  contactId: string | null;
  /** O agente que atende — a linha de custo vai para a conta dele em Uso de IA. */
  agentId: string | null;
  campos: readonly CampoPersonalizado[];
  /** As pendentes do turno, JÁ passadas pelo `scrubMessage`. */
  mensagens: readonly string[];
  config: ConfigDoJev;
}

const TODOS = (campos: readonly CampoPersonalizado[]): string[] => campos.map((c) => c.chave);

/**
 * Pergunta ao Jev sobre o que sobrou do degrau 1 e devolve o veredito por
 * campo. Nunca lança; falha aberto (todos `gravaveis`) com `error_code`.
 */
export async function conferirCamposDoNegocio(
  admin: Admin,
  e: EntradaDaConferencia,
  deps: DependenciasDoPonto = {},
): Promise<ConferenciaDosCampos> {
  const tarefa = TAREFA_DA_CONFERENCIA_DE_CAMPO;
  const estado = estadoEfetivoDaTarefa(e.config, tarefa);
  if (estado === "desligada") {
    return { gravaveis: TODOS(e.campos), recusados: [], estado: "desligada" };
  }
  // Sem fala do cliente não há o que conferir: gravar é o que já acontece hoje,
  // e perguntar ao Jev com estado vazio devolveria "não disse" para tudo.
  if (e.mensagens.length === 0) {
    return { gravaveis: TODOS(e.campos), recusados: [], estado, error_code: "sem_mensagens_do_turno" };
  }

  // Degrau 1 — sem rede.
  const restantes: CampoPersonalizado[] = [];
  for (const campo of e.campos) {
    const literal = degrauUmCobre(campo.valor) && valorDitoLiteralmente(campo.valor, e.mensagens);
    if (!literal) restantes.push(campo);
  }
  if (restantes.length === 0) {
    return { gravaveis: TODOS(e.campos), recusados: [], estado };
  }

  const alvo = { organizationId: e.organizationId, tarefa: CONFERENCIA_DE_CAMPO.purpose };
  if (!podeTentar(alvo)) {
    return { gravaveis: TODOS(e.campos), recusados: [], estado, error_code: codigoDoErroDoJev("disjuntor_aberto") };
  }

  const perguntas: Record<string, Pergunta> = {};
  const ids = new Map<string, { campo: CampoPersonalizado; dito: string; contrario: string }>();
  const usados = new Set<string>();
  for (const campo of restantes) {
    let base = idDaPergunta(campo.chave, "dito").slice("dito_".length);
    while (usados.has(base)) base = `${base}_x`;
    usados.add(base);
    const par = { campo, dito: `dito_${base}`, contrario: `contrario_${base}` };
    ids.set(par.dito, par);
    Object.assign(perguntas, perguntasDoCampo(campo.nome, campo.valor, par));
  }

  const r = await decidirNoPonto(
    { organizationId: e.organizationId, estado: e.mensagens.join("\n"), perguntas },
    {
      ...deps,
      // A chave desta tarefa (e não a de um ponto — não há ponto no registro).
      // `decidirNoPonto` sem `ponto` só resolveria a chave se cada PERGUNTA
      // fosse id de tarefa, e aqui as perguntas são por campo.
      buscarChave: deps.buscarChave ?? ((org: string) => chaveDasTarefas(org, [tarefa])),
    },
  );
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    if (r.motivo !== "sem_credencial") {
      logger.warn("Jev não respondeu sobre os campos do negócio; o valor foi gravado como antes", {
        organization_id: e.organizationId,
        motivo: r.motivo,
      });
    }
    await gravarFalha(admin, e, r);
    return { gravaveis: TODOS(e.campos), recusados: [], estado, error_code: codigoDoErroDoJev(r.motivo) };
  }

  const pareados = [...ids.entries()].map(([ditoId, par]) => {
    const dito = probabilidade(r.respostas[ditoId]);
    const contrario = probabilidade(r.respostas[par.contrario]);
    return { ...par, dito, contrario };
  });
  if (pareados.some((p) => p.dito === null || p.contrario === null)) {
    registrarFalha(alvo, "resposta_ilegivel", Date.now());
    logger.warn("Jev respondeu a um campo do negócio fora de uma probabilidade", {
      organization_id: e.organizationId,
    });
    await gravarFalha(admin, e, {
      ok: false,
      motivo: "resposta_ilegivel",
      exigeAcao: false,
      defeitoNosso: false,
      status: 200,
      latenciaMs: r.latenciaMs,
    });
    return { gravaveis: TODOS(e.campos), recusados: [], estado, error_code: codigoDoErroDoJev("resposta_ilegivel") };
  }
  registrarSucesso(alvo);
  await gravarCusto(admin, e, estado, r);

  const vereditos = pareados.map((p) => {
    const dito = p.dito ?? 0;
    const contrario = p.contrario ?? 0;
    const ok = gravaPeloJev(dito, contrario);
    const motivo: MotivoDaRecusa = contrario >= LIMIAR_CONTRARIO ? "cliente_disse_o_contrario" : "cliente_nao_disse";
    return { ...p, dito, contrario, ok, motivo };
  });

  await gravarObservacao(admin, e, estado, vereditos, r);

  // Observando, GRAVA SEMPRE — a observação é a única consequência. Decidindo,
  // o que o Jev não confirmou volta como ensino e o resto grava.
  const vetados = estado === "decidindo" ? vereditos.filter((v) => !v.ok) : [];
  const recusados: CampoRecusado[] = vetados.map((v) => ({
    campo: v.campo.chave,
    motivo: v.motivo,
    mensagem: ensino(v.campo.nome, v.campo.valor, v.motivo),
  }));
  const vetadas = new Set(recusados.map((r2) => r2.campo));
  return {
    gravaveis: TODOS(e.campos).filter((chave) => !vetadas.has(chave)),
    recusados,
    estado,
  };
}

/** O que a observação guarda por campo: SÓ rótulos e ponteiros. */
async function gravarObservacao(
  admin: Admin,
  e: EntradaDaConferencia,
  estado: EstadoQuePergunta,
  vereditos: ReadonlyArray<{
    campo: CampoPersonalizado;
    dito: number;
    ok: boolean;
    motivo: MotivoDaRecusa;
  }>,
  r: { modelo: string; latenciaMs: number },
): Promise<void> {
  if (vereditos.length === 0) return;
  const { error } = await admin.from("jev_observacoes").insert(
    vereditos.map((v) => ({
      organization_id: e.organizationId,
      tarefa: TAREFA_DA_CONFERENCIA_DE_CAMPO.id,
      estado,
      conversation_id: e.conversationId,
      // Sem `message_id`: são 1 a N mensagens do turno, e o índice único por
      // mensagem não pode deduplicar campos diferentes entre si.
      rotulo_jev: v.ok ? "gravado" : v.motivo,
      probabilidade_jev: v.dito,
      // O que o mecanismo de HOJE fez: gravou sempre. É o par que o cartão
      // lê para contar quantos valores teriam sido devolvidos.
      rotulo_atual: "gravado",
      modelo: r.modelo,
      latencia_ms: r.latenciaMs,
    })),
  );
  if (error) {
    logger.warn("observação da conferência de campo não foi gravada", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}

/** A chamada que deu certo vira linha de custo — o gasto aparece em Uso de IA (molde de `./pedidos`). */
async function gravarCusto(
  admin: Admin,
  e: EntradaDaConferencia,
  estado: EstadoQuePergunta,
  r: { modelo: string; latenciaMs: number; uso: { tokensDeEntrada: number; tokensDeSaida: number } },
): Promise<void> {
  const { error } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: CONFERENCIA_DE_CAMPO.purpose,
    provider: "typesafe",
    model: `typesafe/${r.modelo}`,
    input_tokens: r.uso.tokensDeEntrada,
    output_tokens: r.uso.tokensDeSaida,
    // Versão sem preço na tabela sai `null`, nunca o preço de outra.
    cost_cents: costCents(r.modelo, {
      inputTokens: r.uso.tokensDeEntrada,
      outputTokens: r.uso.tokensDeSaida,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    latency_ms: r.latenciaMs,
    status: "ok",
    // Decidindo, a resposta dele tira o campo da escrita; observando, só fica registrada.
    origem_da_escolha: estado === "decidindo" ? "jev" : "jev_observacao",
  });
  if (error) {
    logger.warn("custo da conferência de campo não foi gravado", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}

/** A falha do degrau 2 vira linha em Execuções com `error_code` (`jev_*`). */
async function gravarFalha(admin: Admin, e: EntradaDaConferencia, falha: FalhaDaDecisao): Promise<void> {
  const { error } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: CONFERENCIA_DE_CAMPO.purpose,
    provider: "typesafe",
    model: `typesafe/${MODELO_DO_JEV}`,
    input_tokens: 0,
    output_tokens: 0,
    cost_cents: 0,
    latency_ms: falha.latenciaMs ?? null,
    status: "erro",
    error_code: codigoDoErroDoJev(falha.motivo),
    http_status: falha.status,
    origem_da_escolha: "jev_observacao",
  });
  if (error) {
    logger.warn("falha da conferência de campo não foi gravada", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}
