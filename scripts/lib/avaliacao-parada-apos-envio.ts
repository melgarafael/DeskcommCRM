/**
 * A AVALIAÇÃO LOCAL da parada do laço depois do envio final declarado — a parte
 * PURA: cenários, identificação de cada execução pelo telefone, classificação de
 * cada turno e o veredito. Sem rede e sem banco; quem lê e escreve é
 * `scripts/avaliar-parada-apos-envio.ts`. Procedimento e critérios:
 * docs/runbooks/parada-apos-envio.md.
 *
 * A régua mora no braço 'observe': o laço não para, então dá para ver o que o
 * modelo faria DEPOIS do envio que ele marcou como final. Para cada turno assim,
 * aplica-se a mesma trava da produção (`envioAnunciaAcaoSeguinte`) ao corpo
 * enviado: se ela teria segurado, a parada não perderia nada; se não, é perda.
 *
 * Todo erro de classificação tem de cair do lado da PERDA, nunca do "segurado":
 * é este relatório que decide ligar o 'on'. Por isso a liberação da trava conta
 * TUDO que a produção conta (inclusive o caso que o fail-safe abre sozinho, que
 * não aparece no traço como ferramenta), e o corpo só é lido quando o ledger
 * não tem nenhuma mensagem além da que o único envio do traço explica.
 */
import { envioAnunciaAcaoSeguinte } from "@/lib/agent-engine/agent/parada-apos-envio";
import type { Database } from "@/lib/database.types";

export type Braco = "off" | "observe";

/** Colunas de `ai_agent_versions` que um cenário ajusta — o nome é conferido contra o tipo do banco. */
export type AjusteDaVersao = Partial<
  Pick<Database["public"]["Tables"]["ai_agent_versions"]["Row"], "cases_enabled" | "handoff_tool_enabled" | "split_messages">
> & {
  /** Somadas ao pacote que o onboarding liga no primeiro agente (`vender`). */
  tool_ids?: readonly string[];
};

export interface Cenario {
  /** Dígito no telefone da execução. */
  codigo: number;
  id: string;
  texto: string;
  /** O que o operador configura no agente ANTES do lote deste cenário. */
  preparo: string;
  /**
   * O mesmo `preparo`, em colunas de `ai_agent_versions`: é o que o
   * `executar --modelo` publica antes do cenário. O que não aparece fica no
   * padrão do primeiro agente do onboarding.
   */
  versao: AjusteDaVersao;
  /** Ferramentas (com `ok`) que contam como a ação esperada; `null` = sem ação esperada. */
  acaoEsperada: readonly string[] | null;
}

export const CENARIOS: readonly Cenario[] = [
  {
    codigo: 0,
    id: "S0",
    texto: "Qual o horário de funcionamento?",
    preparo: "agente padrão",
    versao: {},
    acaoEsperada: null,
  },
  {
    codigo: 1,
    id: "S1-casos-off",
    texto: "Fui cobrado duas vezes no cartão e quero que alguém da empresa resolva hoje",
    preparo: "cases_enabled = false, handoff_tool_enabled = true",
    versao: { cases_enabled: false, handoff_tool_enabled: true },
    acaoEsperada: ["request_human_handoff", "open_human_case"],
  },
  {
    codigo: 2,
    id: "S1-casos-on",
    texto: "Fui cobrado duas vezes no cartão e quero que alguém da empresa resolva hoje",
    preparo: "cases_enabled = true, handoff_tool_enabled = true",
    versao: { cases_enabled: true, handoff_tool_enabled: true },
    acaoEsperada: ["request_human_handoff", "open_human_case"],
  },
  {
    codigo: 3,
    id: "S2-casos-off",
    texto: "Agora estou dirigindo, me chama amanhã às 10h",
    preparo: "cases_enabled = false, retorno (callback) ligado",
    versao: { cases_enabled: false },
    acaoEsperada: ["schedule_followup", "crm_schedule_followup", "open_human_case"],
  },
  {
    codigo: 4,
    id: "S2-casos-on",
    texto: "Agora estou dirigindo, me chama amanhã às 10h",
    preparo: "cases_enabled = true, retorno (callback) ligado",
    versao: { cases_enabled: true },
    acaoEsperada: ["schedule_followup", "crm_schedule_followup", "open_human_case"],
  },
  {
    codigo: 5,
    id: "S3",
    texto: "Tenho interesse no plano anual. Meu nome é Carla Souza, pode registrar meu interesse?",
    preparo: "capacidade crm_create_lead ligada na tela",
    versao: { tool_ids: ["crm_create_lead"] },
    acaoEsperada: ["crm_create_lead"],
  },
  {
    codigo: 6,
    id: "S4",
    texto: "Meu orçamento é de até 5 mil reais e quero fechar ainda este mês",
    preparo: "agente padrão (nota e estágio nativos)",
    versao: {},
    acaoEsperada: ["save_lead_note", "update_lead_state"],
  },
  {
    codigo: 7,
    id: "S5",
    texto: "Me explica em detalhes como funciona, quanto custa e quais são as formas de pagamento",
    preparo: "split_messages = false (o padrão)",
    versao: { split_messages: false },
    acaoEsperada: null,
  },
];

const BRACOS: readonly Braco[] = ["off", "observe"];

/**
 * O começo de todo telefone da avaliação: Brasil (55), DDD 20 e o 9 de celular.
 * O DDD 20 não existe no plano de numeração brasileiro, então nenhum desses
 * números disca nem tem WhatsApp: com o canal errado (WAHA pareado a um número
 * de verdade), o envio falha em vez de chegar a um desconhecido.
 */
export const PREFIXO_DO_TELEFONE = "55209";

/**
 * `55209` + lote(2) + cenário(1) + braço(1) + execução(4): um contato novo por
 * execução, e o telefone diz de que execução o turno é. O lote separa as rodadas
 * de modelos diferentes — sem ele, a 2ª rodada cairia no contato da 1ª.
 */
export function telefoneDaExecucao(lote: number, cenario: Cenario, braco: Braco, k: number): string {
  if (!Number.isInteger(lote) || lote < 0 || lote > 99) throw new Error("lote fora de 0..99");
  if (!Number.isInteger(k) || k < 1 || k > 9999) throw new Error("execução fora de 1..9999");
  return `${PREFIXO_DO_TELEFONE}${String(lote).padStart(2, "0")}${cenario.codigo}${BRACOS.indexOf(braco)}${String(k).padStart(4, "0")}`;
}

/** Casa os telefones de TODAS as execuções de um lote (e de nenhum outro), só dígitos. */
export function padraoDoLote(lote: number): string {
  if (!Number.isInteger(lote) || lote < 0 || lote > 99) throw new Error("lote fora de 0..99");
  return `^${PREFIXO_DO_TELEFONE}${String(lote).padStart(2, "0")}\\d{6}$`;
}

/**
 * O `--modelo` do lote. `provedor:modelo` publica no provedor DIRETO
 * (`openai:gpt-5.6-luna` → a credencial OpenAI da organização); sem `:` é o id
 * da OpenRouter, como antes (`openai/gpt-5.6-luna` → provider `openrouter`).
 */
export function modeloDoLote(texto: string): { provedor: string; modelo: string } {
  const i = texto.indexOf(":");
  if (i < 0) return { provedor: "openrouter", modelo: texto };
  const provedor = texto.slice(0, i);
  const modelo = texto.slice(i + 1);
  if (provedor === "" || modelo === "") throw new Error(`--modelo provedor:modelo ou o id da OpenRouter, veio ${texto}`);
  return { provedor, modelo };
}

/** O que `llm_calls` diz do lote: a soma de `cost_cents` e as chamadas com tokens e sem custo. */
export interface GastoDoLote {
  centavos: number;
  chamadasCegas: number;
}

/**
 * Segue ou para no teto. Chamada com tokens e `cost_cents` nulo ou zero é
 * instrumento cego (modelo sem preço, preço que não chegou): somada, leria como
 * "gastou zero" e o teto nunca dispararia. Por isso lança — falha fechado.
 */
export function conferirTeto(g: GastoDoLote, tetoUsd: number): "segue" | "teto" {
  if (g.chamadasCegas > 0) {
    throw new Error(
      `${g.chamadasCegas} chamada(s) em llm_calls com tokens e sem custo: o teto está cego e o lote para (nulo não é "gastou zero")`,
    );
  }
  return g.centavos / 100 >= tetoUsd ? "teto" : "segue";
}

export function execucaoDoTelefone(
  telefone: string,
): { lote: number; cenario: Cenario; braco: Braco; k: number } | null {
  const m = new RegExp(`^${PREFIXO_DO_TELEFONE}(\\d{2})(\\d)(\\d)(\\d{4})$`).exec(telefone.replace(/\D/g, ""));
  if (!m) return null;
  const cenario = CENARIOS.find((c) => c.codigo === Number(m[2]));
  const braco = BRACOS[Number(m[3])];
  if (cenario === undefined || braco === undefined) return null;
  return { lote: Number(m[1]), cenario, braco, k: Number(m[4]) };
}

/** Uma linha de `agent_turn_traces` com o que o relatório precisa ao lado. */
export interface TurnoMedido {
  jobId: string;
  telefone: string;
  modelo: string | null;
  mensagensEnviadas: number;
  ferramentas: ReadonlyArray<{ nome: string; estado: string; encerra_turno?: boolean }>;
  /**
   * Corpos de TODAS as mensagens físicas que o job registrou no ledger, na ordem
   * de envio. O ledger não diz de onde cada uma veio: bolha do `send_message`,
   * template ou mensagem do sistema depois do laço (a pergunta do roteiro, p.ex.).
   */
  corpos: readonly string[];
  /**
   * Houve caso aberto pelo fail-safe (`agent_cases.source = 'guardrail_autofallback'`)
   * nesta execução. Em produção ele liga `openedCaseThisTurn` e libera a promessa
   * de humano, sem aparecer no traço como ferramenta.
   */
  casoAutomatico: boolean;
  handoffKeywords: readonly string[];
}

export type Desfecho =
  | "sem_risco" // nada depois do envio marcado (ou nenhum envio marcado)
  | "segurado" // agiu depois do envio marcado, e a trava teria segurado a parada
  | "perda" // agiu depois do envio marcado, e a trava NÃO teria segurado
  | "revisar"; // o corpo do envio marcado não é identificável (vários envios, ou o ledger tem mensagem que o traço não explica)

export interface TurnoClassificado {
  jobId: string;
  emRisco: boolean;
  adotou: boolean;
  marcouEAgiu: boolean;
  desfecho: Desfecho;
  acoesAposFinal: string[];
  acaoEsperadaCumprida: boolean | null;
  mensagensEnviadas: number;
}

const ok = (f: { estado: string }) => f.estado === "ok";

export function classificarTurno(t: TurnoMedido, cenario: Cenario): TurnoClassificado {
  const fs = t.ferramentas;
  const ult = fs.length - 1;
  const p1 = fs.findIndex((f) => f.nome === "send_message" && ok(f));
  const pf = fs.findIndex((f) => f.nome === "send_message" && ok(f) && f.encerra_turno === true);
  const marcouEAgiu = pf !== -1 && pf < ult;
  const acaoEsperadaCumprida =
    cenario.acaoEsperada === null
      ? null
      : fs.some((f) => ok(f) && (cenario.acaoEsperada ?? []).includes(f.nome));
  let desfecho: Desfecho = "sem_risco";
  if (marcouEAgiu) {
    const envios = fs.filter((f) => f.nome === "send_message" && ok(f)).length;
    if (envios !== 1 || t.corpos.length !== 1) {
      // ponytail: o traço não liga corpo a chamada; com 1 envio e 1 linha no
      // ledger o vínculo é exato. Fora disso (vários envios, bolhas, mensagem do
      // sistema depois do laço) vai para revisão manual e conta como perda no
      // veredito — uma promessa que só aparece noutra mensagem não seguraria a
      // parada em produção, que lê só o corpo do `send_message`.
      desfecho = "revisar";
    } else {
      const antes = fs.slice(0, pf);
      const humanoAcionado =
        t.casoAutomatico ||
        antes.some((f) => ok(f) && (f.nome === "request_human_handoff" || f.nome === "open_human_case"));
      const retornoGarantido = humanoAcionado || antes.some((f) => ok(f) && f.nome === "schedule_followup");
      desfecho = envioAnunciaAcaoSeguinte(t.corpos.join("\n"), t.handoffKeywords, {
        humanoAcionado,
        retornoGarantido,
      })
        ? "segurado"
        : "perda";
    }
  }
  return {
    jobId: t.jobId,
    emRisco: p1 !== -1 && p1 < ult,
    adotou: pf !== -1,
    marcouEAgiu,
    desfecho,
    acoesAposFinal: pf === -1 ? [] : fs.slice(pf + 1).map((f) => f.nome),
    acaoEsperadaCumprida,
    mensagensEnviadas: t.mensagensEnviadas,
  };
}

/** Limite superior de 95% de uma taxa com 0 eventos em n (exato): 1 − 0,05^(1/n). */
export function limiteSuperiorSemEventos(n: number): number | null {
  return n > 0 ? 1 - 0.05 ** (1 / n) : null;
}

export interface Grupo {
  modelo: string;
  cenario: Cenario;
  braco: Braco;
  turnos: TurnoClassificado[];
}

export interface Criterios {
  /** Execuções em risco exigidas por modelo no braço observe (padrão 80 → limite ≤ 3,7%). */
  minimoEmRisco: number;
  /** Queda tolerada na taxa da ação esperada, observe × off, por cenário (padrão 2/20). */
  tolerancia: number;
}

export const CRITERIOS_PADRAO: Criterios = { minimoEmRisco: 80, tolerancia: 0.1 };

export interface Veredito {
  modelo: string;
  emRisco: number;
  perdas: number;
  revisar: string[];
  limiteSuperior: number | null;
  adocao: number | null;
  resultado: "aprova" | "reprova" | "inconclusivo";
  motivos: string[];
}

const taxa = (n: number, d: number) => (d === 0 ? null : n / d);

export function vereditoDoModelo(modelo: string, grupos: readonly Grupo[], c: Criterios = CRITERIOS_PADRAO): Veredito {
  const doModelo = grupos.filter((g) => g.modelo === modelo);
  const sombra = doModelo.filter((g) => g.braco === "observe").flatMap((g) => g.turnos);
  const emRisco = sombra.filter((t) => t.emRisco).length;
  const perdas = sombra.filter((t) => t.desfecho === "perda").length;
  const revisar = sombra.filter((t) => t.desfecho === "revisar").map((t) => t.jobId);
  const motivos: string[] = [];
  let resultado: Veredito["resultado"] = "aprova";

  // (a) zero perda efetiva — "revisar" conta como perda até alguém olhar.
  if (perdas + revisar.length > 0) {
    resultado = "reprova";
    motivos.push(`${perdas} perda(s) e ${revisar.length} turno(s) a revisar no braço observe`);
  } else if (emRisco < c.minimoEmRisco) {
    resultado = "inconclusivo";
    motivos.push(`${emRisco} execuções em risco; o critério pede ${c.minimoEmRisco}`);
  }

  // (b) influência: a ação esperada não cai além da tolerância; S5 não manda menos.
  for (const cenario of CENARIOS) {
    const off = doModelo.find((g) => g.cenario.id === cenario.id && g.braco === "off")?.turnos ?? [];
    const sh = doModelo.find((g) => g.cenario.id === cenario.id && g.braco === "observe")?.turnos ?? [];
    if (off.length === 0 || sh.length === 0) continue;
    if (cenario.acaoEsperada !== null) {
      const tOff = taxa(off.filter((t) => t.acaoEsperadaCumprida === true).length, off.length) ?? 0;
      const tSh = taxa(sh.filter((t) => t.acaoEsperadaCumprida === true).length, sh.length) ?? 0;
      if (tSh < tOff - c.tolerancia - 1e-9) {
        resultado = "reprova";
        motivos.push(`${cenario.id}: ação esperada ${pct(tSh)} no observe contra ${pct(tOff)} no off`);
      }
    } else if (cenario.id === "S5") {
      const mOff = media(off.map((t) => t.mensagensEnviadas));
      const mSh = media(sh.map((t) => t.mensagensEnviadas));
      if (mSh < mOff) {
        resultado = "reprova";
        motivos.push(`S5: ${mSh.toFixed(2)} mensagens por turno no observe contra ${mOff.toFixed(2)} no off`);
      }
    }
  }

  return {
    modelo,
    emRisco,
    perdas,
    revisar,
    limiteSuperior: perdas + revisar.length === 0 ? limiteSuperiorSemEventos(emRisco) : null,
    adocao: taxa(sombra.filter((t) => t.adotou).length, sombra.length),
    resultado,
    motivos,
  };
}

function media(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

/** Agrupa turnos medidos por modelo × cenário × braço; o que não é da avaliação fica de fora. */
export function agrupar(turnos: readonly TurnoMedido[], lotes?: ReadonlySet<number>): Grupo[] {
  const grupos = new Map<string, Grupo>();
  for (const t of turnos) {
    const e = execucaoDoTelefone(t.telefone);
    if (e === null || (lotes !== undefined && !lotes.has(e.lote))) continue;
    const modelo = t.modelo ?? "(sem modelo)";
    const chave = `${modelo}|${e.cenario.id}|${e.braco}`;
    const g = grupos.get(chave) ?? { modelo, cenario: e.cenario, braco: e.braco, turnos: [] };
    g.turnos.push(classificarTurno(t, e.cenario));
    grupos.set(chave, g);
  }
  return [...grupos.values()];
}
