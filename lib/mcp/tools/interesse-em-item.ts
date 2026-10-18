/**
 * Tool do agente `crm_registrar_interesse_no_item` — o cliente demonstrou
 * interesse num item que uma receita do banco externo devolveu (imóvel, produto,
 * carro) e isso vira LEAD NO FUNIL (Spec 25, R5 / D6).
 *
 * O QUE NÃO SE NEGOCIA, e onde cada coisa é garantida:
 *  - a ORGANIZAÇÃO é a do ctx (turno) — nunca do argumento;
 *  - o CONTATO é `ctx.contatoDoTurno` — o modelo não tem campo para ele, e sem
 *    contato de turno a ferramenta recusa (MCP externo, follow-up, ensaio);
 *  - o item só vale se `crm_consultar_receita` o devolveu NESTE turno
 *    (`ctx.itensDaReceitaNoTurno`); título e preço da nota saem desse snapshot;
 *  - o funil e a etapa vêm da INSTÂNCIA (escolhidos pelo admin) e são conferidos
 *    contra a organização AGORA (`validarDestinoDaInstancia`): o modelo não
 *    escolhe funil, e funil de outra organização nunca recebe lead;
 *  - SEM destino (ou destino que sumiu) = aviso na Central e NENHUM lead. Nunca
 *    "em qualquer funil";
 *  - contato bloqueado (pediu para parar) ou anonimizado não vira lead por aqui.
 *
 * A CRIAÇÃO passa por `crmCreateLead.handler` — o mesmo caminho do `crm_create_lead`
 * (régua de campos da etapa, tenancy, atividade `lead_created`, audit `lead.created`).
 * Nada de regra duplicada.
 *
 * REGRA DE DEDUP (contato + referência): a referência é `<familia>:<id>`
 * (`acf-imoveis:4821`) e fica na `description` do lead dentro de um marcador com
 * delimitadores, `[ref:acf-imoveis:4821]`, para que `…:48` não case com `…:4821`.
 * Antes de criar, procura-se lead do MESMO contato, da MESMA organização,
 * `source = 'external'` e `status = 'open'` que traga o marcador. Achou: NÃO cria;
 * acrescenta a nota "interesse repetido em <data>". Lead GANHO ou PERDIDO não
 * conta (interesse depois de fechar é uma nova oportunidade — quem comprou um
 * imóvel e volta a perguntar do mesmo, ou quem perdeu e reapareceu, volta ao funil
 * como lead novo, que é o que a equipe precisa ver). Dois leads abertos do mesmo
 * contato no mesmo item é impossível por este caminho.
 * Limite conhecido: a referência é `<familia>:<id>`, sem a conexão; dois bancos da
 * MESMA família com o mesmo id para o mesmo contato colidiriam.
 *
 * Teto: `TETO_DE_INTERESSES_POR_TURNO` (3) por turno, no registro do turno. O
 * teto de envios por turno não se aplica (a ferramenta não envia); o de passos
 * (`AGENT_MAX_STEPS`) vale como para qualquer ferramenta.
 *
 * Audit: o caminho do lead audita `lead.created`; os outros desfechos (nota de
 * repetição, aviso sem destino) emitem `external_db_recipes.interest_registered`
 * só com ids, referência e desfecho — nunca texto do cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { abreAvisoDeInteresse, type MotivoDoAvisoDeInteresse } from "@/lib/external-db/receitas/aviso-de-interesse";
import { lerReceitasDoBanco, validarDestinoDaInstancia } from "@/lib/external-db/receitas/instancias";
import {
  marcadorDaReferencia,
  referenciaDoItem,
  textoSeguro,
} from "@/lib/external-db/receitas/itens-do-turno";
import { receitaDe } from "@/lib/external-db/receitas/registro";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

import { crmCreateLead } from "./leads";

const shape = {
  instancia_id: z
    .string()
    .uuid()
    .describe("A `instancia.id` que `crm_consultar_receita` devolveu junto com o item."),
  item_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("O `id` do item, exatamente como a linha devolvida por `crm_consultar_receita` neste turno."),
};

const ENSINO_FORA_DO_TURNO =
  "esse item não veio de uma consulta de receita neste turno. Chame crm_consultar_receita (acao: " +
  "'executar') e use o `id` da linha e a `instancia.id` que ela devolveu.";

function recusa(erro: string, mensagem: string): Record<string, unknown> {
  return { erro, mensagem };
}

async function acharInstancia(
  admin: SupabaseClient,
  organizationId: string,
  instanciaId: string,
): Promise<InstanciaDeReceita | null> {
  const { data, error } = await admin
    .from("external_db_connections")
    .select("id, receitas")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  if (error) throw new Error("conexoes_ilegiveis");
  for (const linha of (data ?? []) as Array<{ receitas: unknown }>) {
    const lida = lerReceitasDoBanco(linha.receitas);
    if (!lida.ok) continue;
    const achada = lida.instancias.find((i) => i.id === instanciaId && i.ativa);
    if (achada) return achada;
  }
  return null;
}

/** Lead ABERTO deste contato que já carrega a referência (a regra de dedup). */
async function leadAbertoComAReferencia(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  referencia: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("id, description")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("source", "external")
    .eq("status", "open")
    // Mais recente primeiro: se o teto cortar algo, corta o lead ANTIGO, que é o
    // que menos provavelmente ainda é o interesse em curso. 200 leads abertos de
    // origem externa para um MESMO contato já é patológico; o teto só protege a
    // memória, não é regra de negócio.
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("leads_ilegiveis");
  const marcador = marcadorDaReferencia(referencia);
  const achado = ((data ?? []) as Array<{ id: string; description: string | null }>).find((l) =>
    (l.description ?? "").includes(marcador),
  );
  return achado?.id ?? null;
}

/**
 * Texto do cliente/banco externo dentro da `description`: sem colchetes, para que
 * um título como "[ref:acf-imoveis:9]" nunca forje o marcador de dedup de OUTRO
 * item. O marcador legítimo é o ÚNICO trecho entre colchetes que a ferramenta grava.
 */
function semColchetes(texto: string): string {
  return texto.replace(/\[/g, "(").replace(/\]/g, ")");
}

function dataBr(d = new Date()): string {
  const [a, m, dia] = d.toISOString().slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}

export const crmRegistrarInteresseNoItem: McpToolDefinition<typeof shape> = {
  name: "crm_registrar_interesse_no_item",
  description:
    "Registra que o cliente desta conversa demonstrou interesse EXPLÍCITO num item que uma receita do banco " +
    "externo devolveu (ex.: 'quero visitar esse apartamento', 'gostei do segundo'). Use só depois de " +
    "crm_consultar_receita neste turno e só quando o cliente disse que quer aquele item, nunca por curiosidade. " +
    "Passe `instancia_id` (a `instancia.id` da consulta) e `item_id` (o `id` da linha). O funil é o configurado pelo " +
    "administrador: você não escolhe funil nem contato. Se a empresa não configurou funil, a equipe é avisada.",
  inputSchema: shape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx: McpContext) => {
    const { instancia_id: instanciaId } = input;
    const itemId = input.item_id.trim();

    const contatoId = ctx.contatoDoTurno;
    if (!contatoId) {
      return recusa("fora_de_conversa", "esta ação só existe dentro de uma conversa com o cliente.");
    }
    const item = ctx.itensDaReceitaNoTurno?.obter(instanciaId, itemId) ?? null;
    if (!ctx.itensDaReceitaNoTurno || !item) {
      return recusa("item_fora_da_consulta_do_turno", ENSINO_FORA_DO_TURNO);
    }

    const admin = ctx.supabase;
    const organizationId = ctx.organizationId;

    // O contato é o da conversa. Bloqueado/anonimizado/pessoal: nada nasce.
    const { data: contato, error: erroDoContato } = await admin
      .from("contacts")
      .select("is_blocked, is_anonymized, is_personal")
      .eq("organization_id", organizationId)
      .eq("id", contatoId)
      .maybeSingle();
    if (erroDoContato) return recusa("indisponivel", "não consegui conferir o contato agora; tente de novo.");
    const flags = contato as { is_blocked?: boolean; is_anonymized?: boolean; is_personal?: boolean } | null;
    if (!flags || flags.is_blocked === true || flags.is_anonymized === true || flags.is_personal === true) {
      return recusa(
        "contato_bloqueado",
        "este contato não pode virar oportunidade (pediu para não receber mensagens, foi anonimizado ou é pessoal). Siga a conversa sem registrar.",
      );
    }

    let instancia: InstanciaDeReceita | null;
    try {
      instancia = await acharInstancia(admin, organizationId, instanciaId);
    } catch {
      return recusa("indisponivel", "não consegui ler as receitas agora; tente de novo.");
    }
    if (!instancia) return recusa("nao_encontrada", "essa receita não existe nesta empresa.");
    const receita = receitaDe(instancia.receita);
    if (!receita) return recusa("nao_encontrada", "essa receita não existe.");

    const referencia = referenciaDoItem(receita.familia, itemId);
    const rotulo = textoSeguro(instancia.rotulo, 80);

    // Já tratado NESTE turno: devolve o mesmo desfecho, sem nota nem aviso duplicados.
    const jaRespondida = ctx.itensDaReceitaNoTurno.respostaDe(instanciaId, itemId);
    if (jaRespondida) return jaRespondida;

    const reserva = ctx.itensDaReceitaNoTurno.reservar(instanciaId, itemId);
    if (reserva === "teto") {
      return recusa(
        "teto_de_interesses_do_turno",
        "já registrei o máximo de interesses neste turno. Continue a conversa; o restante fica para a próxima mensagem do cliente.",
      );
    }

    const guardar = (r: Record<string, unknown>): Record<string, unknown> => {
      ctx.itensDaReceitaNoTurno?.guardarResposta(instanciaId, itemId, r);
      return r;
    };
    const auditar = async (desfecho: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await audit({
        action: "external_db_recipes.interest_registered",
        actorUserId: null,
        actorApiTokenId: ctx.apiTokenId,
        organizationId,
        resourceType: "external_db_recipe",
        resourceId: instanciaId,
        requestId: ctx.requestId,
        metadata: { desfecho, referencia, contact_id: contatoId, ...extra },
      });
    };
    const semLead = async (motivo: MotivoDoAvisoDeInteresse): Promise<Record<string, unknown>> => {
      const avisou = await abreAvisoDeInteresse(admin, {
        organizationId,
        contactId: contatoId,
        motivo,
        titulo: item.titulo,
        referencia,
        receita: rotulo,
      });
      await auditar("aviso_na_central", { motivo, avisou });
      return guardar({
        resultado: "aviso_na_central",
        lead_criado: false,
        mensagem:
          "a empresa ainda não definiu para onde vai esse tipo de interesse, então a equipe foi avisada na Central. " +
          "Responda ao cliente normalmente, sem prometer retorno de um prazo.",
      });
    };

    // SEM destino = aviso, nunca lead.
    if (!instancia.destino) return semLead("sem_destino");
    const veredito = await validarDestinoDaInstancia(admin, organizationId, instancia.destino);
    if (!veredito.ok) {
      if (veredito.motivo === "indisponivel") {
        ctx.itensDaReceitaNoTurno.liberar(instanciaId, itemId);
        return recusa("indisponivel", "não consegui conferir o funil agora; tente de novo.");
      }
      return semLead("destino_indisponivel");
    }

    // DEDUP por contato + referência.
    let existente: string | null;
    try {
      existente = await leadAbertoComAReferencia(admin, organizationId, contatoId, referencia);
    } catch {
      ctx.itensDaReceitaNoTurno.liberar(instanciaId, itemId);
      return recusa("indisponivel", "não consegui conferir os negócios do cliente agora; tente de novo.");
    }
    if (existente) {
      await emitLeadActivity(admin, {
        organizationId,
        leadId: existente,
        contactId: contatoId,
        type: "note",
        sourceModule: "banco_externo",
        sourceId: instanciaId,
        actor: ctx.actor,
        reason: `Interesse repetido em ${dataBr()}: ${item.titulo} (${referencia}).`,
        payload: { referencia, repetido: true },
      });
      await auditar("interesse_repetido", { lead_id: existente });
      return guardar({
        resultado: "interesse_repetido",
        lead_criado: false,
        lead_id: existente,
        mensagem: "esse cliente já tem uma oportunidade aberta para este item; acrescentei uma nota. Siga a conversa.",
      });
    }

    // CRIAÇÃO: o mesmo caminho do `crm_create_lead`.
    let lead: Record<string, unknown>;
    try {
      const criado = (await crmCreateLead.handler(
        {
          pipeline_id: instancia.destino.pipeline_id,
          stage_id: instancia.destino.stage_id,
          title: `Interesse: ${item.titulo}`.slice(0, 200),
          description: `${marcadorDaReferencia(referencia)} Interesse em "${semColchetes(item.titulo)}" (receita ${semColchetes(rotulo)}).`,
          contact_id: contatoId,
          source: "external",
        },
        ctx,
      )) as { lead: Record<string, unknown> };
      lead = criado.lead;
    } catch (err) {
      if (err instanceof ApiError && err.code === "required_fields_missing") return semLead("etapa_exige_campos");
      ctx.itensDaReceitaNoTurno.liberar(instanciaId, itemId);
      if (err instanceof ApiError) {
        return recusa("nao_foi_possivel_criar", "não consegui abrir a oportunidade agora. Siga a conversa normalmente.");
      }
      throw err;
    }
    const leadId = String(lead.id ?? "");

    await emitLeadActivity(admin, {
      organizationId,
      leadId,
      contactId: contatoId,
      type: "note",
      sourceModule: "banco_externo",
      sourceId: instanciaId,
      actor: ctx.actor,
      reason: `Item de interesse: ${item.titulo} · preço: ${item.preco ?? "não informado"} · referência: ${referencia}`,
      payload: { referencia, titulo: item.titulo, preco: item.preco },
    });
    await auditar("lead_criado", { lead_id: leadId });
    return guardar({
      resultado: "lead_criado",
      lead_criado: true,
      lead_id: leadId,
      mensagem: "oportunidade aberta no funil com o item. Siga a conversa.",
    });
  },
};
