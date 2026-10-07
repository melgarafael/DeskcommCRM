/**
 * ANÁLISE DO FUNIL (issue #1750) — a conta, sem rota nem tela.
 *
 * A issue existe porque o gestor não responde três perguntas básicas: quantos
 * passam de cada etapa para a seguinte, quanto tempo leva do primeiro contato
 * ao fechamento, e de que origem vêm os que fecham. O que já existe mede outra
 * coisa: `/metrics/attendants` traz o funil de ABERTOS e ganhos/perdas por
 * atendente; `lib/metrics/perdas.ts` agrupa os motivos de quem perdeu.
 *
 * Dependência declarada (corpo da issue): "o relógio de etapa que já existe" —
 * as passagens são reconstruídas das atividades `stage_changed` já gravadas
 * (`crm_lead_activities.payload.from_stage_id/to_stage_id`), sem tabela nova e
 * sem SQL em banco de produção. Este arquivo é só a conta; quem lê e quem
 * exibe estão na rota e no painel.
 *
 * ─── As regras que este arquivo não deixa errar ───────────────────────────
 *
 * 1. TAXA SEM AMOSTRA NÃO SAI: toda taxa carrega `amostra` (o denominador) e
 *    devolve `null` quando a amostra é 0 — nunca `NaN`, nunca `0` fingindo
 *    medição (doutrina `03-medida-do-proposito.md` §3.4: ausência de dado é
 *    `null`, a tela mostra "—").
 *
 * 2. DENOMINADOR = QUEM ENTROU NA JANELA: `entraram` são os negócios que
 *    ENTRARAM na etapa dentro da janela (criados nela, ou movidos para ela).
 *    Quem já estava na etapa e saiu durante a janela não é entrada — sai em
 *    `saidas_sem_entrada_na_janela`. É por isso que `passaram ≤ entraram` por
 *    construção: a taxa nunca passa de 100%.
 *
 * 3. MOEDA NÃO MISTURA (mesma lei de `lib/metrics/perdas.ts`): valor somado
 *    POR MOEDA, balde próprio para quem não tem moeda, e nenhum total geral —
 *    R$ 1.200 + US$ 900 é um número que não significa nada.
 *
 * 4. DIAS SÓ DE GANHOS: a mediana de `closed_at − created_at` ignora abertos
 *    e perdidos (critério de aceite da issue) e DIZ que é mediana (`medida`),
 *    porque média puxada por um lead parado no funil há um ano mente.
 */

import { SEM_MOEDA } from "@/lib/metrics/perdas";

export interface Janela {
  from: string;
  to: string;
}

/** Uma linha de `crm_lead_activities` com `type = 'stage_changed'`. */
export interface AtividadeDeEtapa {
  lead_id: string;
  de: string | null;
  para: string;
  quando: string;
}

/** Negócio lido na janela (criado nela OU encerrado nela). */
export interface LeadDaJanela {
  id: string;
  pipeline_id: string;
  stage_id: string;
  status: "open" | "won" | "lost";
  source: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface EtapaReferencia {
  id: string;
  nome: string;
  pipeline_id: string;
  posicao: number;
}

export interface FunilReferencia {
  id: string;
  nome: string;
  posicao: number;
}

export interface RefDeEtapa {
  id: string;
  nome: string;
  posicao: number;
}

export interface LinhaDeConversao {
  pipeline_id: string;
  funil: string;
  etapa: RefDeEtapa;
  /** A etapa imediatamente seguinte por posição, ou `null` na última. */
  proxima: RefDeEtapa | null;
  /** Amostra: quem ENTROU na etapa dentro da janela. */
  entraram: number;
  /** Dos que entraram, quantos passaram para a etapa seguinte. */
  passaram: number;
  /** `passaram / entraram`, de 0 a 1 — `null` quando a amostra é 0. */
  taxa: number | null;
  amostra: number;
  /**
   * Saídas de quem já estava na etapa ANTES da janela (então não entram na
   * taxa): sem isto, o leitor veria "entraram 1, passaram 3".
   */
  saidas_sem_entrada_na_janela: number;
  /** Saídas para etapas que não são a seguinte (salto, retrocesso). */
  desvios: number;
}

export interface DiasAteFechar {
  /** Diz QUAL medida é — mediana, nunca média silenciosa. */
  medida: "mediana";
  mediana: number | null;
  p25: number | null;
  p75: number | null;
  amostra: number;
  /** Fechamentos com data de criação ilegível ou anterior ao fechamento. */
  ignorados: number;
  exclui: string;
  por_funil: Array<{
    pipeline_id: string;
    funil: string;
    mediana: number | null;
    p25: number | null;
    p75: number | null;
    amostra: number;
  }>;
}

export interface BaldePorMoeda {
  moeda: string;
  quantidade: number;
  valor_cents: number;
}

export interface LinhaDeOrigem {
  origem: string;
  status: "won" | "lost" | "open";
  quantidade: number;
  por_moeda: BaldePorMoeda[];
}

export interface RelatorioDeFunil {
  janela: Janela;
  /** De que universo saem os números — viaja junto para não virar mentira. */
  base: string;
  conversao: {
    etapas: LinhaDeConversao[];
    /** Total de entradas medidas na janela (soma dos denominadores). */
    amostra: number;
    notas: string[];
  };
  dias_ate_fechar: DiasAteFechar;
  origem: {
    linhas: LinhaDeOrigem[];
    /** Régua 3: valor só por moeda. Este campo é a declaração dela. */
    valor_por_moeda: true;
  };
  vazio: { motivo: string } | null;
}

export const SEM_ORIGEM = "sem origem";
/** Ordem de leitura da matriz origem × status: o que interessa primeiro. */
const ORDEM_DO_STATUS: ReadonlyArray<LeadDaJanela["status"]> = ["won", "lost", "open"];

function dentro(momento: string | null | undefined, janela: Janela): boolean {
  if (!momento) return false;
  const t = Date.parse(momento);
  if (!Number.isFinite(t)) return false;
  const ini = Date.parse(janela.from);
  const fim = Date.parse(janela.to);
  if (!Number.isFinite(ini) || !Number.isFinite(fim)) return false;
  return t >= ini && t < fim;
}

function conta(mapa: Map<string, Set<string>>, chave: string, leadId: string): void {
  const conjunto = mapa.get(chave);
  if (conjunto) conjunto.add(leadId);
  else mapa.set(chave, new Set([leadId]));
}

function redondo(valor: number): number {
  // Dias viram número legível sem virar 2.0000000000000004 no painel.
  return Math.round(valor * 10) / 10;
}

/** Percentil por interpolação linear sobre a lista JÁ ordenada. */
function percentil(ordenados: readonly number[], p: number): number | null {
  const primeiro = ordenados[0];
  if (ordenados.length === 0 || primeiro === undefined) return null;
  if (ordenados.length === 1) return redondo(primeiro);
  const pos = (ordenados.length - 1) * p;
  const base = Math.floor(pos);
  const resto = pos - base;
  const atual = ordenados[base];
  const proximo = ordenados[base + 1];
  if (atual === undefined) return null;
  if (proximo === undefined) return redondo(atual);
  return redondo(atual + resto * (proximo - atual));
}

/**
 * Conversão etapa a etapa, reconstruída das atividades `stage_changed`.
 *
 * Para CADA negócio se monta a sequência de etapas que ele ocupou DENTRO da
 * janela: a etapa de criação (só se ele nasceu na janela) e depois a etapa de
 * cada passagem. Daí saem, por construção:
 *
 * - `entraram` = quem aparece na etapa na sequência (criação ou passagem para
 *   ela, ambas dentro da janela);
 * - `passaram` = quem tem o par (etapa, seguinte) consecutivo na sequência —
 *   sempre subconjunto de `entraram`;
 * - `saidas_sem_entrada_na_janela` = o primeiro salto de quem já morava na
 *   etapa antes da janela (sequência começa no destino, não na origem).
 *
 * O denominador é sempre a amostra da própria linha.
 */
export function calcularConversao(
  atividades: readonly AtividadeDeEtapa[],
  leads: readonly LeadDaJanela[],
  etapas: readonly EtapaReferencia[],
  janela: Janela,
): { etapas: LinhaDeConversao[]; amostra: number; notas: string[] } {
  const transicoesPorLead = new Map<string, AtividadeDeEtapa[]>();
  for (const a of atividades) {
    if (!a.lead_id || !a.para) continue;
    const lista = transicoesPorLead.get(a.lead_id);
    if (lista) lista.push(a);
    else transicoesPorLead.set(a.lead_id, [a]);
  }
  for (const lista of transicoesPorLead.values()) {
    lista.sort(
      (x, y) =>
        (Number.isFinite(Date.parse(x.quando)) ? Date.parse(x.quando) : 0) -
        (Number.isFinite(Date.parse(y.quando)) ? Date.parse(y.quando) : 0),
    );
  }

  const leadPorId = new Map<string, LeadDaJanela>();
  for (const l of leads) leadPorId.set(l.id, l);

  // Negócio com passagem mas sem linha na leitura (janela truncada, ou aberto
  // antigo que só se movimentou) também conta: ele existe no funil.
  const ids = new Set<string>([...leadPorId.keys(), ...transicoesPorLead.keys()]);

  const entradas = new Map<string, Set<string>>();
  const passagens = new Map<string, Set<string>>(); // `${de}>${para}` -> leads
  const semEntrada = new Map<string, Set<string>>();

  for (const id of ids) {
    const lead = leadPorId.get(id);
    const transicoes = transicoesPorLead.get(id) ?? [];
    const nasceuNaJanela = lead ? dentro(lead.created_at, janela) : false;
    const sequencia: string[] = [];

    if (nasceuNaJanela && lead) {
      // Etapa de nascimento = `de` da primeira passagem (nada mudou antes
      // dela), ou a etapa atual quando ele não se moveu.
      const nascimento = transicoes[0]?.de ?? lead.stage_id;
      if (nascimento) sequencia.push(nascimento);
    }
    for (const t of transicoes) sequencia.push(t.para);

    for (const etapa of new Set(sequencia)) conta(entradas, etapa, id);
    for (let i = 0; i + 1 < sequencia.length; i += 1) {
      const de = sequencia[i];
      const para = sequencia[i + 1];
      if (de !== undefined && para !== undefined) conta(passagens, `${de}>${para}`, id);
    }
    // O primeiro salto de quem já estava aqui antes da janela: a origem dele
    // nunca entrou na sequência, então não pode entrar na taxa.
    const primeira = transicoes[0];
    if (!nasceuNaJanela && primeira?.de) conta(semEntrada, primeira.de, id);
  }

  const porPipeline = new Map<string, EtapaReferencia[]>();
  for (const e of etapas) {
    const lista = porPipeline.get(e.pipeline_id);
    if (lista) lista.push(e);
    else porPipeline.set(e.pipeline_id, [e]);
  }

  // Só os funis que têm vida na janela: lead lido ou passagem registrada.
  const funisVivos = new Set<string>();
  for (const l of leadPorId.values()) funisVivos.add(l.pipeline_id);
  const pipelineDaEtapa = new Map<string, string>();
  for (const [pipeline, lista] of porPipeline) {
    for (const e of lista) {
      pipelineDaEtapa.set(e.id, pipeline);
      if (entradas.has(e.id) || semEntrada.has(e.id)) funisVivos.add(pipeline);
    }
  }
  for (const chave of passagens.keys()) {
    const [de] = chave.split(">");
    const pipeline = de ? pipelineDaEtapa.get(de) : undefined;
    if (pipeline) funisVivos.add(pipeline);
  }

  const linhas: LinhaDeConversao[] = [];
  let amostra = 0;
  for (const [pipeline, lista] of porPipeline) {
    if (!funisVivos.has(pipeline)) continue;
    const ordenadas = [...lista].sort((a, b) => Number(a.posicao) - Number(b.posicao));
    for (let i = 0; i < ordenadas.length; i += 1) {
      const etapa = ordenadas[i];
      const proxima = ordenadas[i + 1];
      if (!etapa) continue;
      const entraram = entradas.get(etapa.id)?.size ?? 0;
      const passaram = proxima ? (passagens.get(`${etapa.id}>${proxima.id}`)?.size ?? 0) : 0;
      // Sem etapa seguinte, toda saída é desvio: não há destino "o esperado".
      const desvios = desviosDo(etapa.id, passagens, proxima?.id ?? null);
      const taxa = entraram > 0 && proxima ? passaram / entraram : null;
      amostra += entraram;
      linhas.push({
        pipeline_id: pipeline,
        funil: "",
        etapa: { id: etapa.id, nome: etapa.nome, posicao: Number(etapa.posicao) },
        proxima: proxima
          ? { id: proxima.id, nome: proxima.nome, posicao: Number(proxima.posicao) }
          : null,
        entraram,
        passaram,
        taxa,
        amostra: entraram,
        saidas_sem_entrada_na_janela: semEntrada.get(etapa.id)?.size ?? 0,
        desvios,
      });
    }
  }

  const notas = [
    "Contagem por lead distinto em cada coluna; a taxa é passaram ÷ entraram, com a amostra da própria linha.",
    "Entraram = criados na etapa ou movidos para ela DENTRO da janela; saídas de quem já estava antes saem em saidas_sem_entrada_na_janela.",
    "Só conta a passagem para a etapa imediatamente seguinte por posição; saltos e retrocessos ficam em desvios.",
  ];
  return { etapas: linhas, amostra, notas };
}

function desviosDo(
  etapaId: string,
  passagens: Map<string, Set<string>>,
  proximaId: string | null,
): number {
  let total = 0;
  const prefixo = `${etapaId}>`;
  for (const [chave, conjunto] of passagens) {
    if (!chave.startsWith(prefixo)) continue;
    const destino = chave.slice(prefixo.length);
    if (proximaId !== null && destino === proximaId) continue;
    total += conjunto.size;
  }
  return total;
}

/** Mediana e quartis de `closed_at − created_at` dos GANHOS da janela. */
export function calcularDiasAteFechar(
  leads: readonly LeadDaJanela[],
  janela: Janela,
  funis: readonly FunilReferencia[] = [],
): DiasAteFechar {
  const nomes = new Map(funis.map((f) => [f.id, f.nome]));
  const exclui = "Só ganhos com fechamento na janela: abertos e perdidos ficam de fora.";

  const amostras: number[] = [];
  const porPipeline = new Map<string, number[]>();
  let ignorados = 0;

  for (const lead of leads) {
    if (lead.status !== "won" || !dentro(lead.closed_at, janela)) continue;
    const inicio = Date.parse(lead.created_at);
    const fim = Date.parse(lead.closed_at ?? "");
    if (!Number.isFinite(inicio) || !Number.isFinite(fim)) {
      ignorados += 1;
      continue;
    }
    const dias = (fim - inicio) / 86_400_000;
    // Negativo é dado corrompido (fechado antes de nascer), não é "zero dias".
    if (dias < 0) {
      ignorados += 1;
      continue;
    }
    const arredondado = redondo(dias);
    amostras.push(arredondado);
    const lista = porPipeline.get(lead.pipeline_id);
    if (lista) lista.push(arredondado);
    else porPipeline.set(lead.pipeline_id, [arredondado]);
  }

  amostras.sort((a, b) => a - b);
  const ordena = (l: number[]) => [...l].sort((a, b) => a - b);

  return {
    medida: "mediana",
    mediana: percentil(amostras, 0.5),
    p25: percentil(amostras, 0.25),
    p75: percentil(amostras, 0.75),
    amostra: amostras.length,
    ignorados,
    exclui,
    por_funil: [...porPipeline.entries()]
      .map(([pipeline_id, lista]) => {
        const ordenada = ordena(lista);
        return {
          pipeline_id,
          funil: nomes.get(pipeline_id) ?? pipeline_id,
          mediana: percentil(ordenada, 0.5),
          p25: percentil(ordenada, 0.25),
          p75: percentil(ordenada, 0.75),
          amostra: ordenada.length,
        };
      })
      .sort((a, b) => a.funil.localeCompare(b.funil, "pt-BR")),
  };
}

/** Matriz `source × status`, com valor agregado POR MOEDA. */
export function calcularOrigem(
  leads: readonly LeadDaJanela[],
  janela: Janela,
): LinhaDeOrigem[] {
  const naJanela = leads.filter(
    (l) => dentro(l.created_at, janela) || dentro(l.closed_at, janela),
  );

  const quantidade = new Map<string, Map<LeadDaJanela["status"], number>>();
  const moedas = new Map<string, Map<LeadDaJanela["status"], Map<string, BaldePorMoeda>>>();

  for (const lead of naJanela) {
    const origem = lead.source?.trim() || SEM_ORIGEM;
    const porStatus = quantidade.get(origem) ?? new Map<LeadDaJanela["status"], number>();
    porStatus.set(lead.status, (porStatus.get(lead.status) ?? 0) + 1);
    quantidade.set(origem, porStatus);

    const statusMap =
      moedas.get(origem) ??
      new Map<LeadDaJanela["status"], Map<string, BaldePorMoeda>>();
    const baldeStatus = statusMap.get(lead.status) ?? new Map<string, BaldePorMoeda>();
    const moeda = lead.currency?.trim() || SEM_MOEDA;
    const balde = baldeStatus.get(moeda) ?? { moeda, quantidade: 0, valor_cents: 0 };
    balde.quantidade += 1;
    balde.valor_cents += lead.value_cents ?? 0;
    baldeStatus.set(moeda, balde);
    statusMap.set(lead.status, baldeStatus);
    moedas.set(origem, statusMap);
  }

  const linhas: LinhaDeOrigem[] = [];
  for (const origem of [...quantidade.keys()].sort((a, b) => a.localeCompare(b, "pt-BR"))) {
    const porStatus = quantidade.get(origem);
    if (!porStatus) continue;
    const statusVistos = ORDEM_DO_STATUS.filter((s) => porStatus.has(s));
    for (const status of statusVistos) {
      const baldeStatus = moedas.get(origem)?.get(status);
      const porMoeda = [...(baldeStatus?.values() ?? [])].sort((a, b) => {
        // O balde sem moeda é ausência, não é código ISO: fica por último.
        const semA = Number(a.moeda === SEM_MOEDA);
        const semB = Number(b.moeda === SEM_MOEDA);
        if (semA !== semB) return semA - semB;
        return a.moeda.localeCompare(b.moeda, "pt-BR");
      });
      linhas.push({
        origem,
        status,
        quantidade: porStatus.get(status) ?? 0,
        por_moeda: porMoeda,
      });
    }
  }
  return linhas;
}

/**
 * O relatório inteiro, pronto para a rota devolver. É esta função que o teste
 * fixa: entrada pequena e determinística, saída com as três respostas.
 */
export function montarRelatorioDeFunil(entrada: {
  janela: Janela;
  atividades: readonly AtividadeDeEtapa[];
  leads: readonly LeadDaJanela[];
  etapas: readonly EtapaReferencia[];
  funis?: readonly FunilReferencia[];
}): RelatorioDeFunil {
  const { janela, atividades, leads, etapas } = entrada;
  const funis = entrada.funis ?? [];
  const conversao = calcularConversao(atividades, leads, etapas, janela);
  const nomes = new Map(funis.map((f) => [f.id, f.nome]));
  for (const linha of conversao.etapas) linha.funil = nomes.get(linha.pipeline_id) ?? linha.pipeline_id;

  const semDado = leads.length === 0 && atividades.length === 0;

  return {
    janela,
    base: "Negócios criados OU encerrados na janela; passagens de etapa registradas na janela.",
    conversao,
    dias_ate_fechar: calcularDiasAteFechar(leads, janela, funis),
    origem: { linhas: calcularOrigem(leads, janela), valor_por_moeda: true },
    vazio: semDado
      ? {
          motivo:
            "Nenhum negócio lido na janela: sem passagem de etapa, sem ganho, perda ou aberto no período. Isto é 'sem dado', não 'conversão zero' — a taxa fica nula até chegar amostra.",
        }
      : null,
  };
}

/** Torna legível o que a rota devolve quando não há nada a meder. */
export function relatorioVazio(janela: Janela): RelatorioDeFunil {
  return montarRelatorioDeFunil({ janela, atividades: [], leads: [], etapas: [], funis: [] });
}

/** Guarda de sanidade: nenhum número não-finite vaza para a tela. */
export function temNaN(valor: unknown): boolean {
  if (typeof valor === "number") return !Number.isFinite(valor);
  if (Array.isArray(valor)) return valor.some(temNaN);
  if (valor && typeof valor === "object") return Object.values(valor).some(temNaN);
  return false;
}
