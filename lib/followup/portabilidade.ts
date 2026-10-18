/**
 * Exportar e importar um fluxo como ARQUIVO — o mesmo fluxo em outra conta.
 *
 * ═══ Por que existe ═════════════════════════════════════════════════════════
 *
 * Montar um fluxo no canvas é delicado: uma aresta solta, um ramo sem saída, e
 * o "Publicar" recusa. Quem acertou um fluxo numa organização tinha de redesenhá-lo
 * nó a nó em outra — ou na mesma instalação depois de um teste. O arquivo leva o
 * fluxo inteiro (grafo, gatilho e política de handoff) e volta como RASCUNHO.
 *
 * ═══ O que o arquivo NÃO carrega ════════════════════════════════════════════
 *
 * Inscrições, versões publicadas, vínculo com agente e o estado `active`. A
 * importação nunca publica: o fluxo importado nasce `draft`, e só manda mensagem
 * depois de passar pelo mesmo `validate-publish` de qualquer fluxo desenhado à mão.
 * Importar é o caminho do DUPLICAR (`[id]/duplicate`), vindo de fora.
 *
 * ═══ O problema dos ids — e a regra ════════════════════════════════════════
 *
 * O grafo aponta para linhas da organização por `uuid`: a etapa do `move_lead`, a
 * etapa de uma condição `lead_stage`, o modelo de mensagem do `action`, a pessoa
 * da tarefa interna, o próximo roteiro do `end`, a etapa do gatilho. Em outra
 * organização esses ids não existem.
 *
 * Por isso o arquivo leva, ao lado do grafo, o NOME de cada coisa referenciada
 * (`references`). Ao importar, cada id é conferido contra a organização ativa:
 *
 *   1. o id existe aqui → fica como está (importar na mesma conta);
 *   2. não existe, mas o nome casa com UMA linha daqui → troca pelo id daqui;
 *   3. não casa → o campo fica vazio (ou volta ao valor neutro) e vira PENDÊNCIA,
 *      dita na tela, para a pessoa escolher antes de publicar.
 *
 * O caso 3 nunca "chuta": nome que casa com duas etapas também é pendência. E
 * nada aqui inventa conteúdo — um modelo de mensagem que não existe não vira texto.
 *
 * Este arquivo é PURO: quem lê o banco é a rota, que entrega o `ContextoDaConta`.
 */
import { z } from "zod";

import { triggerConfigSchema, FOLLOWUP_FLOW_SURFACES, type TriggerConfig } from "./api-schemas";
import { flowGraphSchema, type FlowGraph, type FlowNode } from "./graph-schema";
import { randomId } from "@/lib/random-id";
import type { Idioma } from "@/lib/i18n/idiomas";

import { MAX_FOLLOWUP_FLOW_NAME } from "./nome-da-copia";

/** Identifica o arquivo. Mudar quebra todo arquivo já exportado — não mude. */
export const FORMATO_DO_ARQUIVO = "followup_flow" as const;
/** Sobe quando o envelope muda de forma incompatível. O GRAFO tem o versionamento próprio (v1/v2 dos ramos). */
export const VERSAO_DO_FORMATO = 1 as const;

/** Teto do corpo da importação. Um grafo no limite (60 nós, 120 arestas) fica muito abaixo disto. */
export const TAMANHO_MAXIMO_DO_ARQUIVO = 512 * 1024;

export const HANDOFF_POLICIES = ["pause", "cancel", "allow"] as const;

const nomesSchema = z.record(z.string().uuid(), z.string().min(1).max(200));

/**
 * O que acompanha o grafo para a importação conseguir achar a coisa certa em
 * outra conta. Tudo opcional: um arquivo escrito à mão (ou por uma IA) sem esta
 * seção é válido — as referências viram pendência em vez de remapeamento.
 */
export const referenciasSchema = z.strictObject({
  /** id → «Etapa · Funil», o mesmo rótulo que a tela mostra. */
  stages: nomesSchema.optional(),
  /** id → título do modelo (Ajustes › Modelos) ou nome do modelo aprovado do canal. */
  templates: nomesSchema.optional(),
  /** id → nome do fluxo (o `proximo_fluxo` de um roteiro). */
  flows: nomesSchema.optional(),
  /** id → nome do tipo de compromisso (gatilho de falta). */
  event_types: nomesSchema.optional(),
});
export type Referencias = z.infer<typeof referenciasSchema>;

export const arquivoDeFluxoSchema = z.strictObject({
  format: z.literal(FORMATO_DO_ARQUIVO),
  version: z.literal(VERSAO_DO_FORMATO),
  exported_at: z.string().max(40).optional(),
  flow: z.strictObject({
    name: z.string().trim().min(1).max(MAX_FOLLOWUP_FLOW_NAME),
    surface: z.enum(FOLLOWUP_FLOW_SURFACES).optional(),
    handoff_policy: z.enum(HANDOFF_POLICIES).default("pause"),
    trigger_config: triggerConfigSchema.default({ kind: "manual" }),
    graph: flowGraphSchema,
  }),
  references: referenciasSchema.optional(),
});
export type ArquivoDeFluxo = z.infer<typeof arquivoDeFluxoSchema>;

/** O fluxo como o ponteiro guarda — a entrada da exportação. */
export interface FluxoParaExportar {
  name: string;
  surface: string | null;
  handoff_policy: string;
  trigger_config: unknown;
  graph: FlowGraph;
}

/** Nomes das linhas da organização de ORIGEM que o grafo cita (a rota busca). */
export interface NomesDaOrigem {
  stages: Map<string, string>;
  templates: Map<string, string>;
  flows: Map<string, string>;
  event_types: Map<string, string>;
}

// ─── Leitura das referências de um grafo ────────────────────────────────────

/** Todo id de linha da organização que o grafo e o gatilho citam, por tipo. */
export interface IdsCitados {
  stages: Set<string>;
  templates: Set<string>;
  users: Set<string>;
  flows: Set<string>;
  event_types: Set<string>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idsCitados(graph: FlowGraph, trigger: TriggerConfig | null): IdsCitados {
  const ids: IdsCitados = {
    stages: new Set(),
    templates: new Set(),
    users: new Set(),
    flows: new Set(),
    event_types: new Set(),
  };
  for (const node of graph.nodes) {
    switch (node.type) {
      case "move_lead":
        if (UUID_RX.test(node.config.stage_id)) ids.stages.add(node.config.stage_id);
        break;
      case "condition":
        for (const check of node.config.checks) {
          if (
            check.field === "lead_stage" &&
            typeof check.value === "string" &&
            UUID_RX.test(check.value)
          ) {
            ids.stages.add(check.value);
          }
        }
        break;
      case "action":
        if (node.config.mode === "template") ids.templates.add(node.config.template_id);
        if (node.config.mode === "ai_message" && node.config.fallback_template_id) {
          ids.templates.add(node.config.fallback_template_id);
        }
        break;
      case "internal_task":
        if (typeof node.config.atribuir_a === "object")
          ids.users.add(node.config.atribuir_a.usuario_id);
        break;
      case "end":
        if (
          node.config.ao_finalizar?.tipo === "proximo_fluxo" &&
          UUID_RX.test(node.config.ao_finalizar.fluxo)
        ) {
          ids.flows.add(node.config.ao_finalizar.fluxo);
        }
        break;
      default:
        break;
    }
  }
  if (trigger?.kind === "stage_change") ids.stages.add(trigger.params.stage_id);
  if (trigger?.kind === "appointment_no_show") {
    for (const id of trigger.params?.event_type_ids ?? []) ids.event_types.add(id);
  }
  return ids;
}

// ─── Exportação ─────────────────────────────────────────────────────────────

function mapaParaRegistro(
  ids: Set<string>,
  nomes: Map<string, string>,
): Record<string, string> | undefined {
  const registro: Record<string, string> = {};
  for (const id of ids) {
    const nome = nomes.get(id);
    if (nome) registro[id] = nome.slice(0, 200);
  }
  return Object.keys(registro).length > 0 ? registro : undefined;
}

/**
 * Monta o arquivo. O gatilho que não parseia (jsonb escrito por fora) sai como
 * `manual` — exportar um gatilho que a importação recusaria entregaria um
 * arquivo que não volta.
 */
export function montarArquivoDeFluxo(
  fluxo: FluxoParaExportar,
  nomes: NomesDaOrigem,
  agora: Date,
): ArquivoDeFluxo {
  const gatilho = triggerConfigSchema.safeParse(fluxo.trigger_config ?? { kind: "manual" });
  const trigger_config: TriggerConfig = gatilho.success ? gatilho.data : { kind: "manual" };
  const handoff = (HANDOFF_POLICIES as readonly string[]).includes(fluxo.handoff_policy)
    ? (fluxo.handoff_policy as (typeof HANDOFF_POLICIES)[number])
    : "pause";
  const surface = (FOLLOWUP_FLOW_SURFACES as readonly string[]).includes(fluxo.surface ?? "")
    ? (fluxo.surface as (typeof FOLLOWUP_FLOW_SURFACES)[number])
    : undefined;

  const citados = idsCitados(fluxo.graph, trigger_config);
  const references: Referencias = {};
  const stages = mapaParaRegistro(citados.stages, nomes.stages);
  const templates = mapaParaRegistro(citados.templates, nomes.templates);
  const flows = mapaParaRegistro(citados.flows, nomes.flows);
  const event_types = mapaParaRegistro(citados.event_types, nomes.event_types);
  if (stages) references.stages = stages;
  if (templates) references.templates = templates;
  if (flows) references.flows = flows;
  if (event_types) references.event_types = event_types;

  return {
    format: FORMATO_DO_ARQUIVO,
    version: VERSAO_DO_FORMATO,
    exported_at: agora.toISOString(),
    flow: {
      name: fluxo.name.trim().slice(0, MAX_FOLLOWUP_FLOW_NAME) || "Fluxo",
      ...(surface ? { surface } : {}),
      handoff_policy: handoff,
      trigger_config,
      graph: fluxo.graph,
    },
    ...(Object.keys(references).length > 0 ? { references } : {}),
  };
}

/** Nome do arquivo baixado: o nome do fluxo sem o que um sistema de arquivos recusa. */
export function nomeDoArquivo(nomeDoFluxo: string): string {
  const base = nomeDoFluxo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return `${base || "fluxo"}.fluxo.json`;
}

// ─── Importação ─────────────────────────────────────────────────────────────

/** O que a organização de DESTINO tem, por id → nome. A rota lê; aqui só se compara. */
export interface ContextoDaConta {
  stages: Map<string, string>;
  templates: Map<string, string>;
  /** Membros ativos (aceitos, não revogados). */
  users: Set<string>;
  flows: Map<string, string>;
  event_types: Map<string, string>;
}

export type CodigoDaPendencia =
  | "etapa_remapeada"
  | "etapa_nao_encontrada"
  | "modelo_remapeado"
  | "modelo_nao_encontrado"
  | "modelo_reserva_removido"
  | "responsavel_trocado"
  | "proximo_fluxo_removido"
  | "proximo_fluxo_remapeado"
  | "gatilho_trocado_para_manual";

/**
 * Uma coisa que a pessoa precisa saber depois da importação. `bloqueia` = o fluxo
 * não pode ir ao ar sem ela resolver (a própria publicação recusa ou o envio
 * falharia); `false` = foi resolvido sozinho e só está sendo avisado.
 */
export interface Pendencia {
  codigo: CodigoDaPendencia;
  bloqueia: boolean;
  /** Nó afetado (id e rótulo como o canvas mostra). Ausente = é do gatilho. */
  no?: { id: string; label: string };
  /** Nome da coisa no arquivo de origem, quando ele trouxe. */
  referencia?: string;
}

export interface ResultadoDaImportacao {
  graph: FlowGraph;
  trigger_config: TriggerConfig;
  pendencias: Pendencia[];
}

/**
 * Acha a linha daqui que corresponde a um id de fora. `null` = não há UMA só.
 * Compara sem acento e sem caixa: «Proposta Enviada» e «proposta enviada» são
 * a mesma etapa para quem as criou, e nenhuma organização tem as duas.
 */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

export function resolverPorNome(
  nome: string | undefined,
  daqui: Map<string, string>,
): string | null {
  if (!nome) return null;
  const alvo = normalizar(nome);
  const exatos = [...daqui].filter(([, n]) => normalizar(n) === alvo);
  if (exatos.length === 1) return exatos[0]![0];
  if (exatos.length > 1) return null;
  // Etapa: o rótulo é «Etapa · Funil». Sem o funil igual, a etapa sozinha só
  // vale quando é única na conta — duas «Proposta» em funis diferentes é pendência.
  const [soEtapa] = nome.split(" · ");
  if (!soEtapa || soEtapa === nome) return null;
  const alvoEtapa = normalizar(soEtapa);
  const pelaEtapa = [...daqui].filter(([, n]) => normalizar(n.split(" · ")[0] ?? n) === alvoEtapa);
  return pelaEtapa.length === 1 ? pelaEtapa[0]![0] : null;
}

type Resolucao = { tipo: "mantido" } | { tipo: "remapeado"; id: string } | { tipo: "ausente" };

function resolver(
  id: string,
  daqui: Map<string, string>,
  nomesDeFora: Record<string, string> | undefined,
): Resolucao {
  if (daqui.has(id)) return { tipo: "mantido" };
  const remapeado = resolverPorNome(nomesDeFora?.[id], daqui);
  return remapeado ? { tipo: "remapeado", id: remapeado } : { tipo: "ausente" };
}

/**
 * Confere cada referência do arquivo contra a conta e devolve o grafo PRONTO para
 * gravar como rascunho, mais o que a pessoa precisa saber. Nunca lança: o arquivo
 * já foi validado pelo `arquivoDeFluxoSchema`, e o que sobra aqui é decisão.
 */
export function reconciliarComAConta(
  arquivo: ArquivoDeFluxo,
  conta: ContextoDaConta,
): ResultadoDaImportacao {
  const refs = arquivo.references ?? {};
  const pendencias: Pendencia[] = [];
  const noRef = (node: FlowNode) => ({ id: node.id, label: node.label });

  const nodes: FlowNode[] = arquivo.flow.graph.nodes.map((node) => {
    switch (node.type) {
      case "move_lead": {
        const id = node.config.stage_id;
        if (!id.trim()) return node; // rascunho sem destino: o publish já cobra
        const r = resolver(id, conta.stages, refs.stages);
        if (r.tipo === "mantido") return node;
        if (r.tipo === "remapeado") {
          pendencias.push({
            codigo: "etapa_remapeada",
            bloqueia: false,
            no: noRef(node),
            referencia: refs.stages?.[id],
          });
          return { ...node, config: { ...node.config, stage_id: r.id } };
        }
        pendencias.push({
          codigo: "etapa_nao_encontrada",
          bloqueia: true,
          no: noRef(node),
          referencia: refs.stages?.[id],
        });
        return { ...node, config: { ...node.config, stage_id: "" } };
      }

      case "condition": {
        let mudou = false;
        const checks = node.config.checks.map((check) => {
          if (
            check.field !== "lead_stage" ||
            typeof check.value !== "string" ||
            !UUID_RX.test(check.value)
          ) {
            return check;
          }
          const r = resolver(check.value, conta.stages, refs.stages);
          if (r.tipo === "mantido") return check;
          if (r.tipo === "remapeado") {
            mudou = true;
            pendencias.push({
              codigo: "etapa_remapeada",
              bloqueia: false,
              no: noRef(node),
              referencia: refs.stages?.[check.value],
            });
            return { ...check, value: r.id };
          }
          // Fica o id de fora: o `validate-publish` recusa (`check_stage_not_found`)
          // e a tela da condição mostra a regra para a pessoa escolher a etapa.
          pendencias.push({
            codigo: "etapa_nao_encontrada",
            bloqueia: true,
            no: noRef(node),
            referencia: refs.stages?.[check.value],
          });
          return check;
        });
        return mudou ? { ...node, config: { ...node.config, checks } } : node;
      }

      case "action": {
        if (node.config.mode === "template") {
          const id = node.config.template_id;
          const r = resolver(id, conta.templates, refs.templates);
          if (r.tipo === "mantido") return node;
          if (r.tipo === "remapeado") {
            pendencias.push({
              codigo: "modelo_remapeado",
              bloqueia: false,
              no: noRef(node),
              referencia: refs.templates?.[id],
            });
            return { ...node, config: { ...node.config, template_id: r.id } };
          }
          // O modo `template` exige um id (uuid) — não há "vazio" válido. Fica o
          // de fora, e a pendência BLOQUEIA: a publicação também recusaria
          // (`modelo_inexistente`), mas esta tela avisa antes de o fluxo existir.
          pendencias.push({
            codigo: "modelo_nao_encontrado",
            bloqueia: true,
            no: noRef(node),
            referencia: refs.templates?.[id],
          });
          return node;
        }
        if (node.config.mode === "ai_message" && node.config.fallback_template_id) {
          const id = node.config.fallback_template_id;
          const r = resolver(id, conta.templates, refs.templates);
          if (r.tipo === "mantido") return node;
          if (r.tipo === "remapeado") {
            pendencias.push({
              codigo: "modelo_remapeado",
              bloqueia: false,
              no: noRef(node),
              referencia: refs.templates?.[id],
            });
            return { ...node, config: { ...node.config, fallback_template_id: r.id } };
          }
          // Opcional: sai. Se a espera longa exigir plano B, o publish cobra
          // (`long_wait_needs_template`) — a régua de lá, não uma segunda aqui.
          pendencias.push({
            codigo: "modelo_reserva_removido",
            bloqueia: false,
            no: noRef(node),
            referencia: refs.templates?.[id],
          });
          const { fallback_template_id: _removido, ...resto } = node.config;
          return { ...node, config: resto };
        }
        return node;
      }

      case "internal_task": {
        const alvo = node.config.atribuir_a;
        if (typeof alvo !== "object" || conta.users.has(alvo.usuario_id)) return node;
        // Pessoa de outra conta não tem nome portável (e-mail não sai no arquivo).
        // `dono_do_lead` é o valor que não depende de quem está na equipe hoje.
        pendencias.push({ codigo: "responsavel_trocado", bloqueia: false, no: noRef(node) });
        return { ...node, config: { ...node.config, atribuir_a: "dono_do_lead" } };
      }

      case "end": {
        const fim = node.config.ao_finalizar;
        if (fim?.tipo !== "proximo_fluxo") return node;
        const r = resolver(fim.fluxo, conta.flows, refs.flows);
        if (r.tipo === "mantido") return node;
        if (r.tipo === "remapeado") {
          pendencias.push({
            codigo: "proximo_fluxo_remapeado",
            bloqueia: false,
            no: noRef(node),
            referencia: refs.flows?.[fim.fluxo],
          });
          return {
            ...node,
            config: { ...node.config, ao_finalizar: { tipo: "proximo_fluxo", fluxo: r.id } },
          };
        }
        pendencias.push({
          codigo: "proximo_fluxo_removido",
          bloqueia: false,
          no: noRef(node),
          referencia: refs.flows?.[fim.fluxo],
        });
        return { ...node, config: { ...node.config, ao_finalizar: { tipo: "nada" } } };
      }

      default:
        return node;
    }
  });

  let trigger_config: TriggerConfig = arquivo.flow.trigger_config;
  if (trigger_config.kind === "stage_change") {
    const id = trigger_config.params.stage_id;
    const r = resolver(id, conta.stages, refs.stages);
    if (r.tipo === "remapeado") {
      pendencias.push({
        codigo: "etapa_remapeada",
        bloqueia: false,
        referencia: refs.stages?.[id],
      });
      trigger_config = { ...trigger_config, params: { stage_id: r.id } };
    } else if (r.tipo === "ausente") {
      // `stage_change` exige uma etapa (uuid) que exista; manual é o gatilho que
      // não dispara sozinho — o mais seguro para um fluxo que acabou de chegar.
      pendencias.push({
        codigo: "gatilho_trocado_para_manual",
        bloqueia: true,
        referencia: refs.stages?.[id],
      });
      trigger_config = {
        kind: "manual",
        ...(trigger_config.cancel_on_reply !== undefined
          ? { cancel_on_reply: trigger_config.cancel_on_reply }
          : {}),
      };
    }
  } else if (trigger_config.kind === "appointment_no_show") {
    const pedidos = trigger_config.params?.event_type_ids ?? [];
    const daqui: string[] = [];
    let faltou = false;
    for (const id of pedidos) {
      const r = resolver(id, conta.event_types, refs.event_types);
      if (r.tipo === "mantido") daqui.push(id);
      else if (r.tipo === "remapeado") daqui.push(r.id);
      else faltou = true;
    }
    // Lista vazia quer dizer "todo tipo de compromisso" — tirar só os ausentes
    // ALARGARIA o gatilho em silêncio. Um ausente basta para voltar a manual.
    if (faltou) {
      pendencias.push({ codigo: "gatilho_trocado_para_manual", bloqueia: true });
      trigger_config = {
        kind: "manual",
        ...(trigger_config.cancel_on_reply !== undefined
          ? { cancel_on_reply: trigger_config.cancel_on_reply }
          : {}),
      };
    } else if (pedidos.length > 0) {
      trigger_config = { ...trigger_config, params: { event_type_ids: daqui } };
    }
  }

  return { graph: { ...arquivo.flow.graph, nodes }, trigger_config, pendencias };
}

/**
 * Nome livre para o fluxo importado (`unique (organization_id, name)`). O nome do
 * arquivo vence; ocupado, ganha « (importado)» e depois « (importado N)».
 */
export function nomeDoImportado(original: string, ocupados: Iterable<string>): string {
  const taken = new Set(ocupados);
  const raiz = original.trim().slice(0, MAX_FOLLOWUP_FLOW_NAME) || "Fluxo importado";
  if (!taken.has(raiz)) return raiz;
  for (let n = 1; n < 1000; n++) {
    const sufixo = n === 1 ? " (importado)" : ` (importado ${n})`;
    const nome =
      raiz.length + sufixo.length <= MAX_FOLLOWUP_FLOW_NAME
        ? raiz + sufixo
        : raiz.slice(0, MAX_FOLLOWUP_FLOW_NAME - sufixo.length) + sufixo;
    if (!taken.has(nome)) return nome;
  }
  return `${raiz.slice(0, 71)} ${randomId().slice(0, 8)}`.slice(0, MAX_FOLLOWUP_FLOW_NAME);
}

// `Record<Idioma, …>`: idioma novo promovido no registro obriga a escolher o locale aqui.
const LOCALE_DO_ZOD: Record<Idioma, () => { localeError: z.core.$ZodErrorMap }> = {
  "pt-BR": z.locales.pt,
  es: z.locales.es,
};

/**
 * O idioma das mensagens GENÉRICAS do Zod numa leitura
 * (`schema.safeParse(x, zodNoIdioma(idioma))`). Sem isto a lista de problemas
 * saía em inglês («Invalid UUID») para quem lê em português ou espanhol. As
 * frases são as dos locales que o próprio Zod traz.
 *
 * Mensagem escrita no schema vence o locale e sai como está: em `graph-schema.ts`
 * parte delas é inglês («min_ms must be <= max_ms») e parte é português, que
 * quem lê em espanhol recebe em português.
 */
export function zodNoIdioma(idioma: Idioma): { error: z.core.$ZodErrorMap } {
  // ponytail: locale `pt` do Zod é português de Portugal («Demasiado pequeno»); troque por mapa próprio se alguém tropeçar.
  return { error: LOCALE_DO_ZOD[idioma]().localeError };
}

/**
 * Os problemas de um arquivo recusado, um por linha, com o caminho até o campo
 * («flow.graph.nodes.3.config.duration_ms: …»). É o que a tela mostra — o
 * `flatten()` do Zod perde o caminho dos nós, que é justamente o que a pessoa
 * precisa para achar o erro num arquivo de 200 linhas.
 */
export function problemasDoArquivo(erro: z.ZodError, limite = 20): string[] {
  return erro.issues.slice(0, limite).map((issue) => {
    const caminho = issue.path.map(String).join(".");
    return caminho ? `${caminho}: ${issue.message}` : issue.message;
  });
}
