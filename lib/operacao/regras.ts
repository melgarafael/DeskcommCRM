/**
 * A OPERAÇÃO DO DIA — as regras puras, separadas do banco para o teste prendê-las.
 *
 * Tudo aqui é decisão sem I/O: onde começa e termina "o dia" no fuso da
 * organização, quem espera uma pessoa, como as etiquetas da conversa viram as
 * seções da tela, o que a busca de produtos da IA deixou registrado e quando o
 * cron deve gerar o relatório. Quem LÊ o banco é `operacao-do-dia.ts`; quem
 * escreve o relatório é `relatorio-diario.ts`.
 *
 * ─── Nada é inventado ───────────────────────────────────────────────────────
 *
 * Cada campo da tela sai de uma coluna que existe. Quando a coluna está vazia,
 * o campo é `null` e a tela diz "não registrado" — nunca um valor estimado.
 */
import { z } from "zod";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { silencioVigente, STATUS_ENCERRADOS } from "@/lib/inbox/comando-da-conversa";
import { conversationTagSchema } from "@/lib/schemas/messaging";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import type { LinhaDeConversa } from "./tipos";

// ─── O DIA NO FUSO DA ORGANIZAÇÃO ───────────────────────────────────────────

const DIA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` de calendário real (rejeita 2026-02-30). */
export function diaValido(dia: string): boolean {
  const m = DIA_ISO.exec(dia);
  if (!m) return false;
  const [ano, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const data = new Date(Date.UTC(ano, mes - 1, d));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === d;
}

/** O dia de calendário (`YYYY-MM-DD`) do instante, no fuso dado. */
export function diaNoFuso(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante, fusoUtilizavel(fuso));
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

/** O dia seguinte de calendário — aritmética de calendário, nunca blocos de 24 h. */
export function diaSeguinte(dia: string): string {
  const m = DIA_ISO.exec(dia);
  if (!m) throw new Error(`dia inválido: ${dia}`);
  const data = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return data.toISOString().slice(0, 10);
}

/**
 * O intervalo `[inicio, fim)` do dia no fuso. O dia de virada do horário de
 * verão tem 23 ou 25 horas, e é por isso que o fim é a meia-noite do dia
 * SEGUINTE, e não `inicio + 24 h`. Na meia-noite que não existe (Beirute pula de
 * 23:59 para 01:00 na entrada do verão) o dia começa no primeiro instante que
 * existiu — a regra de `instanteDe`.
 */
export function limitesDoDia(dia: string, fuso: string): { inicio: Date; fim: Date } {
  if (!diaValido(dia)) throw new Error(`dia inválido: ${dia}`);
  const tz = fusoUtilizavel(fuso);
  const [ano, mes, d] = dia.split("-").map(Number) as [number, number, number];
  const [ano2, mes2, d2] = diaSeguinte(dia).split("-").map(Number) as [number, number, number];
  return {
    inicio: instanteDe({ ano, mes, dia: d }, tz),
    fim: instanteDe({ ano: ano2, mes: mes2, dia: d2 }, tz),
  };
}

export type DiaPedido = { ok: true; dia: string } | { ok: false; motivo: "dia_invalido" | "dia_no_futuro" };

/** O dia pedido (ou hoje, no fuso). Dia futuro é recusado: não há o que mostrar. */
export function resolverDia(bruto: string | null | undefined, fuso: string, agora = new Date()): DiaPedido {
  const hoje = diaNoFuso(agora, fuso);
  if (!bruto) return { ok: true, dia: hoje };
  if (!diaValido(bruto)) return { ok: false, motivo: "dia_invalido" };
  if (bruto > hoje) return { ok: false, motivo: "dia_no_futuro" };
  return { ok: true, dia: bruto };
}

/** A hora de parede (0..23) do instante no fuso. */
export function horaNoFuso(instante: Date, fuso: string): number {
  return partesNoFuso(instante, fusoUtilizavel(fuso)).hora;
}

/** "HH:MM" no fuso — o "atualizado às" da tela e a hora das linhas do relatório. */
export function horaCurtaNoFuso(instante: Date | string, fuso: string): string {
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) return "";
  const p = partesNoFuso(d, fusoUtilizavel(fuso));
  return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}

// ─── A CONFIGURAÇÃO (organizations.settings.operacao_do_dia) ────────────────

export const TAGS_PADRAO = {
  produto: "produto",
  projeto: "projeto",
  // Com acento: é a etiqueta canônica que as organizações já usam
  // (`settings.canonical_conversation_tags`), e a comparação é a do produto —
  // `conversationTagSchema`: trim + minúscula, sem tirar acento.
  reclamacao: "reclamação",
  urgente: "urgente",
} as const;

/**
 * Pedaços de nome de etapa que a organização trata como "proposta". Comparados
 * sem acento e sem caixa, como pedaço do nome: "Proposta enviada" casa
 * "proposta". A organização troca a lista; esta é só a semente.
 */
export const ETAPAS_DE_PROPOSTA_PADRAO = ["proposta", "orcamento", "presupuesto", "cotacao", "proposal", "quote"];

export const RELATORIO_PADRAO = { ligado: true, hora: 21 } as const;

/** Etiqueta de conversa como o produto grava (`conversationTagSchema`): trim, minúscula, 1..40. */
const tagSchema = conversationTagSchema;

/** A mesma normalização, para comparar a etiqueta lida da conversa. */
export function normalizarEtiqueta(tag: string): string {
  return tag.trim().toLowerCase();
}

export const configuracaoSchema = z.object({
  tags: z
    .object({
      produto: tagSchema.optional(),
      projeto: tagSchema.optional(),
      reclamacao: tagSchema.optional(),
      urgente: tagSchema.optional(),
    })
    .optional(),
  etapas_de_proposta: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  relatorio: z
    .object({
      ligado: z.boolean().optional(),
      hora: z.number().int().min(0).max(23).optional(),
    })
    .optional(),
});

export type ConfiguracaoBruta = z.input<typeof configuracaoSchema>;

export interface ConfiguracaoDaOperacao {
  tags: { produto: string; projeto: string; reclamacao: string; urgente: string };
  etapas_de_proposta: string[];
  relatorio: { ligado: boolean; hora: number };
}

/**
 * Lê `settings.operacao_do_dia` com padrão seguro. Nunca lança: um valor torto
 * gravado à mão no jsonb cai no padrão CAMPO A CAMPO, e não derruba a tela.
 */
export function lerConfiguracao(settings: unknown): ConfiguracaoDaOperacao {
  const bruto =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>).operacao_do_dia : undefined;
  const obj = bruto && typeof bruto === "object" ? (bruto as Record<string, unknown>) : {};
  const campo = <T>(schema: z.ZodType<T>, valor: unknown): T | undefined => {
    const r = schema.safeParse(valor);
    return r.success ? r.data : undefined;
  };
  const tagsBrutas = obj.tags && typeof obj.tags === "object" ? (obj.tags as Record<string, unknown>) : {};
  const rel = obj.relatorio && typeof obj.relatorio === "object" ? (obj.relatorio as Record<string, unknown>) : {};
  return {
    tags: {
      produto: campo(tagSchema, tagsBrutas.produto) ?? TAGS_PADRAO.produto,
      projeto: campo(tagSchema, tagsBrutas.projeto) ?? TAGS_PADRAO.projeto,
      reclamacao: campo(tagSchema, tagsBrutas.reclamacao) ?? TAGS_PADRAO.reclamacao,
      urgente: campo(tagSchema, tagsBrutas.urgente) ?? TAGS_PADRAO.urgente,
    },
    etapas_de_proposta:
      campo(configuracaoSchema.shape.etapas_de_proposta.unwrap(), obj.etapas_de_proposta) ?? [
        ...ETAPAS_DE_PROPOSTA_PADRAO,
      ],
    relatorio: {
      ligado: campo(z.boolean(), rel.ligado) ?? RELATORIO_PADRAO.ligado,
      hora: campo(z.number().int().min(0).max(23), rel.hora) ?? RELATORIO_PADRAO.hora,
    },
  };
}

const semAcento = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** O nome da etapa casa algum dos pedaços que a organização marcou como proposta? */
export function etapaEhDeProposta(nomeDaEtapa: string, pedacos: readonly string[]): boolean {
  const nome = semAcento(nomeDaEtapa);
  return pedacos.some((p) => {
    const pedaco = semAcento(p);
    return pedaco.length > 0 && nome.includes(pedaco);
  });
}

// ─── AS SEÇÕES POR ETIQUETA ─────────────────────────────────────────────────

export type SecaoPorEtiqueta = "projetos" | "reclamacoes" | "produtos";

/**
 * Em quais seções a conversa entra, pelas etiquetas dela. Uma conversa pode
 * estar em mais de uma (pedido de produto que virou reclamação). Reclamação e
 * urgente são a MESMA seção: as duas pedem ação da equipe primeiro.
 */
export function secoesDaConversa(
  tags: readonly string[] | null | undefined,
  config: ConfiguracaoDaOperacao["tags"],
): SecaoPorEtiqueta[] {
  const minusculas = new Set((tags ?? []).map(normalizarEtiqueta));
  const secoes: SecaoPorEtiqueta[] = [];
  if (minusculas.has(config.projeto)) secoes.push("projetos");
  if (minusculas.has(config.reclamacao) || minusculas.has(config.urgente)) secoes.push("reclamacoes");
  if (minusculas.has(config.produto)) secoes.push("produtos");
  return secoes;
}

// ─── QUEM ESPERA UMA PESSOA ─────────────────────────────────────────────────

export interface ConversaParaEspera {
  status: string;
  comando_da_conversa?: string | null;
  is_group?: boolean | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  awaiting_since: string | null;
  bot_silenced_until?: string | null;
  assigned_to_user_id?: string | null;
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);

/** O cliente falou por último (sem resposta nenhuma também conta)? */
export function clienteFalouPorUltimo(c: Pick<ConversaParaEspera, "last_inbound_at" | "last_outbound_at">): boolean {
  const entrada = ms(c.last_inbound_at);
  if (Number.isNaN(entrada)) return false;
  const saida = ms(c.last_outbound_at);
  return Number.isNaN(saida) || entrada > saida;
}

/**
 * A conversa espera uma PESSOA agora?
 *
 *   - `aguardando`: o banco diz que ela foi entregue à equipe e ninguém
 *     assumiu (a régua da aba Fila) — espera, mesmo que alguém tenha mandado
 *     uma mensagem automática depois.
 *   - `ninguem` (sem robô e sem dono) ou `humano` (uma pessoa é a dona): espera
 *     quando o cliente falou por último.
 *   - silêncio do robô vigente com o cliente falando por último também espera:
 *     ninguém automático vai responder.
 *
 * Grupo e conversa encerrada nunca entram.
 */
export function esperaUmaPessoa(c: ConversaParaEspera, agora: Date): boolean {
  if (c.is_group) return false;
  if (STATUS_ENCERRADOS.has(c.status)) return false;
  const comando = c.comando_da_conversa ?? null;
  if (comando === "aguardando") return true;
  if (!clienteFalouPorUltimo(c)) return false;
  if (comando === "ninguem" || comando === "humano") return true;
  if (c.assigned_to_user_id) return true;
  return silencioVigente(c.bot_silenced_until ?? null, agora).vigente;
}

/** Desde quando o cliente espera: `awaiting_since` só vale se for posterior à nossa última resposta. */
export function esperandoDesde(c: ConversaParaEspera): string | null {
  const saida = ms(c.last_outbound_at);
  if (c.awaiting_since && (Number.isNaN(saida) || ms(c.awaiting_since) > saida)) return c.awaiting_since;
  return c.last_inbound_at ?? null;
}

/** Minutos inteiros de espera, sempre ≥ 0. `null` quando não há instante. */
export function minutosDeEspera(desde: string | null | undefined, agora: Date): number | null {
  const inicio = ms(desde);
  if (Number.isNaN(inicio)) return null;
  return Math.max(0, Math.floor((agora.getTime() - inicio) / 60_000));
}

/** "25 min", "2 h 05 min", "3 d 4 h" — curto e sempre para baixo. */
export function duracaoCurta(minutos: number | null): string {
  if (minutos === null) return "";
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  if (h < 48) {
    const resto = minutos % 60;
    return resto === 0 ? `${h} h` : `${h} h ${String(resto).padStart(2, "0")} min`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d} d` : `${d} d ${rh} h`;
}

// ─── O QUE A BUSCA DE PRODUTOS DA IA DEIXOU REGISTRADO ──────────────────────

/** O nome da ferramenta cuja chamada vira "produtos pedidos". */
export const FERRAMENTA_DE_PRODUTOS = "crm_search_products";

export interface ProdutosPedidos {
  termos: string[];
  encontrados: string[];
}

/**
 * Extrai de `ai_agent_runs.tool_calls` (lista de passos `{ tool_calls: [{
 * tool_name, args, result }] }`, `lib/ai/runtime/serialize.ts`) o termo
 * buscado e os nomes devolvidos. Formato torto não lança: o que não se lê fica
 * de fora. O termo é o que a pessoa escreveu (`args.termo`); os nomes são os de
 * `result.produtos[].nome`.
 */
export function produtosDasChamadas(toolCalls: unknown): ProdutosPedidos {
  const termos: string[] = [];
  const encontrados: string[] = [];
  if (!Array.isArray(toolCalls)) return { termos, encontrados };
  for (const passo of toolCalls) {
    const chamadas = passo && typeof passo === "object" ? (passo as { tool_calls?: unknown }).tool_calls : null;
    if (!Array.isArray(chamadas)) continue;
    for (const chamada of chamadas) {
      if (!chamada || typeof chamada !== "object") continue;
      const c = chamada as { tool_name?: unknown; args?: unknown; result?: unknown };
      if (c.tool_name !== FERRAMENTA_DE_PRODUTOS) continue;
      const termo =
        c.args && typeof c.args === "object" ? (c.args as { termo?: unknown }).termo : undefined;
      if (typeof termo === "string" && termo.trim() !== "") termos.push(termo.trim().slice(0, 120));
      const produtos =
        c.result && typeof c.result === "object" ? (c.result as { produtos?: unknown }).produtos : undefined;
      if (Array.isArray(produtos)) {
        for (const p of produtos) {
          const nome = p && typeof p === "object" ? (p as { nome?: unknown }).nome : undefined;
          if (typeof nome === "string" && nome.trim() !== "") encontrados.push(nome.trim().slice(0, 120));
        }
      }
    }
  }
  return { termos, encontrados };
}

/** Junta, sem repetir (sem caixa), preservando a primeira grafia e a ordem. */
export function juntarProdutos(a: ProdutosPedidos, b: ProdutosPedidos): ProdutosPedidos {
  const unir = (x: string[], y: string[]) => {
    const vistos = new Set<string>();
    const out: string[] = [];
    for (const s of [...x, ...y]) {
      const k = s.toLowerCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(s);
    }
    return out.slice(0, 30);
  };
  return { termos: unir(a.termos, b.termos), encontrados: unir(a.encontrados, b.encontrados) };
}

// ─── QUANDO O CRON GERA O RELATÓRIO ─────────────────────────────────────────

/** O que já está gravado para um dia: quem gerou e quando. */
export interface RelatorioExistente {
  gerado_por: "cron" | "usuario";
  gerado_em: string;
}

/**
 * Uma geração que o cron deve fazer.
 *
 *   - `dia_perdido`: o dia local ANTERIOR ficou sem relatório (a instalação
 *     estava parada na hora, ou o cron falhou). Ele é gerado agora, já fechado
 *     — dia inteiro —, e só se ainda não existe linha (`on conflict do nothing`).
 *   - `hora_marcada`: hoje, a partir da hora marcada, sem linha.
 *   - `refazer_apos_manual`: hoje (ou ontem) já tem linha, mas foi o botão
 *     "Gerar agora" ANTES da hora marcada daquele dia. O manual não cancela o
 *     automático: o cron regera uma vez, por cima, e a linha passa a
 *     `gerado_por = 'cron'` — não há laço, porque a condição deixa de valer.
 */
export interface AcaoDoCron {
  dia: string;
  motivo: "dia_perdido" | "hora_marcada" | "refazer_apos_manual";
  /** Para `refazer_apos_manual`: só sobrescreve a linha manual gravada antes deste instante. */
  substituirManualAntesDe?: string;
}

export type DecisaoDoCron =
  | { acoes: AcaoDoCron[]; motivo?: undefined }
  | { acoes: []; motivo: "desligado" | "antes_da_hora" | "ja_existe" };

/** O dia de calendário anterior. */
export function diaAnterior(dia: string): string {
  const m = DIA_ISO.exec(dia);
  if (!m) throw new Error(`dia inválido: ${dia}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1)).toISOString().slice(0, 10);
}

/** O instante da hora marcada, num dia, no fuso da organização. */
export function instanteDaHoraMarcada(dia: string, hora: number, fuso: string): Date {
  const [ano, mes, d] = dia.split("-").map(Number) as [number, number, number];
  return instanteDe({ ano, mes, dia: d, hora }, fusoUtilizavel(fuso));
}

/**
 * O cron roda a cada 15 min e decide, por organização, o que gerar AGORA.
 * A unicidade `(organization_id, dia)` no banco é o que segura a corrida — esta
 * decisão só evita trabalho à toa.
 *
 * `existentes` traz as linhas de HOJE e de ONTEM (dias locais). `criadaEm` é a
 * criação da organização: o dia anterior só é recuperado se a organização já
 * existia nele — uma instalação nova não ganha o relatório de um dia em que
 * não operava.
 */
export function decisaoDoCron(input: {
  agora: Date;
  fuso: string;
  config: ConfiguracaoDaOperacao["relatorio"];
  existentes: ReadonlyMap<string, RelatorioExistente>;
  criadaEm?: string | null;
}): DecisaoDoCron {
  if (!input.config.ligado) return { acoes: [], motivo: "desligado" };
  const acoes: AcaoDoCron[] = [];
  const hoje = diaNoFuso(input.agora, input.fuso);
  const ontem = diaAnterior(hoje);

  // Linha do botão "Gerar agora" de ANTES da hora marcada daquele dia: o cron
  // ainda deve o automático dele. Vale para hoje e para ontem — se a instalação
  // parou entre o manual e a hora marcada, o dia de ontem não pode ficar para
  // sempre com o relatório cortado na hora do clique.
  const manualAntesDaHora = (dia: string, marcadaDoDia: Date): boolean => {
    const linha = input.existentes.get(dia);
    return linha?.gerado_por === "usuario" && new Date(linha.gerado_em).getTime() < marcadaDoDia.getTime();
  };

  const fimDeOntem = limitesDoDia(ontem, input.fuso).fim;
  const existiaOntem = !input.criadaEm || new Date(input.criadaEm).getTime() < fimDeOntem.getTime();
  const marcadaDeOntem = instanteDaHoraMarcada(ontem, input.config.hora, input.fuso);
  if (existiaOntem && !input.existentes.has(ontem)) acoes.push({ dia: ontem, motivo: "dia_perdido" });
  else if (manualAntesDaHora(ontem, marcadaDeOntem)) {
    acoes.push({ dia: ontem, motivo: "refazer_apos_manual", substituirManualAntesDe: marcadaDeOntem.toISOString() });
  }

  const marcada = instanteDaHoraMarcada(hoje, input.config.hora, input.fuso);
  if (input.agora.getTime() >= marcada.getTime()) {
    if (!input.existentes.has(hoje)) acoes.push({ dia: hoje, motivo: "hora_marcada" });
    else if (manualAntesDaHora(hoje, marcada)) {
      acoes.push({ dia: hoje, motivo: "refazer_apos_manual", substituirManualAntesDe: marcada.toISOString() });
    }
  }

  if (acoes.length > 0) return { acoes };
  return { acoes: [], motivo: input.agora.getTime() < marcada.getTime() ? "antes_da_hora" : "ja_existe" };
}

// ─── O CORTE DO DIA E O ESTADO DO MOMENTO ───────────────────────────────────

/**
 * Até onde a leitura alcançou o dia. Uma leitura feita DEPOIS do fim do dia
 * (um dia passado, o relatório de recuperação) cobre o dia inteiro; feita
 * dentro dele, vai de 00:00 até o instante da leitura.
 *
 * É também a régua do ESTADO DO MOMENTO: quem espera uma pessoa, o que está em
 * proposta, as mensagens presas, os canais fora do ar e os avisos abertos são
 * o estado de AGORA, não do dia. Eles só fazem sentido numa leitura feita
 * DENTRO do dia — num dia que já acabou, mostrar o estado de hoje como se fosse
 * o daquele dia seria mentira.
 */
export function corteDoDia(c: { inicio: string; fim: string; lido_em: string }): {
  diaInteiro: boolean;
  ate: string;
  estadoDoMomento: boolean;
} {
  const lido = new Date(c.lido_em).getTime();
  const diaInteiro = lido >= new Date(c.fim).getTime();
  return { diaInteiro, ate: diaInteiro ? c.fim : c.lido_em, estadoDoMomento: !diaInteiro };
}

/**
 * A linha de conversa num dia que JÁ ACABOU. Situação, comando, responsável,
 * motivo da última passagem, próxima tarefa e espera são o estado de AGORA, não
 * o daquele dia — saem, pela mesma régua do estado do momento. A última
 * atividade fica, mas limitada ao dia: a última mensagem da conversa pode ser
 * de hoje, e a tela mostra só "HH:MM". Fora do dia, vale a última entrada do
 * cliente DENTRO dele (`ultimaEntradaNoDia`), ou nada.
 */
export function linhaDeUmDiaQueAcabou(
  linha: LinhaDeConversa,
  fimDoDia: string,
  ultimaEntradaNoDia: string | null,
): LinhaDeConversa {
  const ultima = linha.ultima_atividade_em;
  const dentro = ultima !== null && new Date(ultima).getTime() < new Date(fimDoDia).getTime();
  return {
    ...linha,
    status: null,
    comando: null,
    motivo_codigo: null,
    proxima_acao: null,
    responsavel_user_id: null,
    responsavel: null,
    responsavel_tipo: null,
    ultima_atividade_em: dentro ? ultima : ultimaEntradaNoDia,
    esperando_desde: null,
  };
}
