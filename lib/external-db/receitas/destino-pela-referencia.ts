/**
 * O FUNIL DO INTERESSE, ACHADO PELA REFERÊNCIA DO ITEM (Spec 25, R5c).
 *
 * Medido no espelho (22/10/2026): o destino configurado na receita (R5b) chegava
 * ao agente dentro do resultado da consulta, e esse resultado NÃO acompanha a
 * conversa. No turno em que o cliente dizia "tenho interesse nesse", o agente não
 * tinha o funil nem a etapa, não abria o negócio e ainda escrevia "registrei seu
 * interesse". Duas tentativas, duas vezes: nenhum `crm_create_lead`.
 *
 * Aqui o sistema resolve sozinho: o agente passa só a referência do item
 * (`<receita>:<id>`, que ele lê da conversa) e o funil e a etapa saem da receita
 * da organização. O agente nunca escolhe o funil — quem escolheu foi o dono, na
 * tela de receitas.
 *
 * A organização vem SEMPRE de quem chama. O cliente de serviço ignora a RLS, então
 * o filtro é explícito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehReferenciaExterna } from "@/lib/leads/referencia-externa";

import type { DestinoDoInteresse } from "./destino-do-interesse";
import { nomesDoDestinoValido } from "./destino-no-banco";
import { lerReceitasDoBanco } from "./instancias";
import { conferirItemDaReferencia } from "./item-da-referencia";

export type DestinoPelaReferencia =
  | { ok: true; destino: DestinoDoInteresse }
  | {
      ok: false;
      motivo: "referencia_invalida" | "sem_destino" | "destino_ambiguo" | "indisponivel";
      mensagem: string;
    };

/**
 * O REGISTRO de uma criação que seguiu sem item para conferir (#4763, item 2).
 *
 * O valor vai para o `motivo` da auditoria da chamada que deu certo: o negócio
 * nasceu à mão, num funil que não é destino de receita nenhuma — ou fora de um
 * turno de conversa. Um número sem esse registro é indistinguível de um negócio
 * que nasceu de um item conferido, e é essa diferença que a issue pede para não
 * se perder.
 */
export const DECLARACAO_SEM_ITEM = "funil_a_mao_sem_item" as const;

/** O que se sabe do chamador na hora da criação — o turno tem contato? */
export interface ContextoDaCriacao {
  /**
   * A chamada vem de um turno de CONVERSA (`ctx.contatoDoTurno`, o mesmo
   * contexto de confiança de `lib/mcp/types.ts`). Ausente nos ingressos de fora
   * do turno — rota MCP, automação, integração —, e a ausência mantém o
   * comportamento deles intacto, como no resto do catálogo.
   */
  turnoComContato?: boolean;
}

export type DestinoCompletado =
  | { ok: true; declaracao?: typeof DECLARACAO_SEM_ITEM }
  | { ok: false; resposta: Record<string, unknown> };

const PASSE_PARA_A_EQUIPE =
  "Não abra o negócio por conta própria: chame crm_request_human_handoff e diga ao cliente que a equipe dará continuidade.";

/** A receita da referência (`wordpress-conteudo:4821` → `wordpress-conteudo`). */
function receitaDaReferencia(referencia: string): string {
  return referencia.slice(0, referencia.indexOf(":"));
}

/**
 * Procura, nas conexões ativas da organização, o destino das instâncias ATIVAS da
 * receita da referência. Só vale se existir exatamente UM destino válido: nenhum
 * é "esta receita não tem funil" e mais de um (instâncias da mesma receita com
 * funis diferentes) é ambíguo — nos dois casos o agente passa para a equipe, em
 * vez de o sistema adivinhar.
 */
export async function destinoPelaReferencia(
  admin: SupabaseClient,
  organizationId: string,
  referencia: string,
): Promise<DestinoPelaReferencia> {
  if (!ehReferenciaExterna(referencia)) {
    return {
      ok: false,
      motivo: "referencia_invalida",
      mensagem:
        "a referência do item deve ter o formato <receita>:<id>, com o id de uma linha que crm_consultar_receita devolveu.",
    };
  }
  const receita = receitaDaReferencia(referencia);

  const { data, error } = await admin
    .from("external_db_connections")
    .select("receitas")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  if (error) {
    return {
      ok: false,
      motivo: "indisponivel",
      mensagem: `não foi possível ler as receitas agora. ${PASSE_PARA_A_EQUIPE}`,
    };
  }

  const destinos = new Map<string, DestinoDoInteresse>();
  for (const conexao of (data ?? []) as { receitas: unknown }[]) {
    const lida = lerReceitasDoBanco(conexao.receitas);
    if (!lida.ok) continue;
    for (const instancia of lida.instancias) {
      if (!instancia.ativa || instancia.receita !== receita || !instancia.destino_do_interesse) continue;
      // O funil pode ter sido arquivado depois de configurado: destino que não vale
      // mais não conta.
      if (!(await nomesDoDestinoValido(admin, organizationId, instancia.destino_do_interesse))) continue;
      const { pipeline_id, stage_id } = instancia.destino_do_interesse;
      destinos.set(`${pipeline_id}:${stage_id}`, { pipeline_id, stage_id });
    }
  }

  if (destinos.size === 0) {
    return {
      ok: false,
      motivo: "sem_destino",
      mensagem: `esta receita não tem funil de destino configurado. ${PASSE_PARA_A_EQUIPE}`,
    };
  }
  if (destinos.size > 1) {
    return {
      ok: false,
      motivo: "destino_ambiguo",
      mensagem: `há mais de um funil de destino para esta receita. ${PASSE_PARA_A_EQUIPE}`,
    };
  }
  return { ok: true, destino: [...destinos.values()][0]! };
}

/**
 * Completa `pipeline_id` e `stage_id` dos argumentos de `crm_create_lead` quando
 * o agente passou só a `referencia_externa`. EDITA `args` no lugar: o chamador
 * (o wrapper do agente) precisa dos valores ANTES do escopo de funil, que julga o
 * funil que vai ser escrito — preencher depois deixaria a guarda olhando para um
 * argumento ausente.
 *
 * Funil e etapa informados pelo chamador nunca são trocados.
 *
 * Com `referencia_externa`, o item TEM de existir no banco de origem, com ou sem
 * funil informado: a forma da referência não prova nada (o agente inventou o
 * código em 2 de 2 turnos reais, ver `item-da-referencia.ts`).
 *
 * ─── O FUNIL À MÃO SEM REFERÊNCIA (#4763, item 2) ───────────────────────────
 *
 * Medido com IA real (`gpt-6-luna`, 16/11): numa rodada em que a receita estava
 * inacessível, o modelo passou `pipeline_id`/`stage_id` à mão e NÃO passou
 * `referencia_externa`; o negócio "Casa com piscina em Alphaville — AU-9999"
 * nasceu de um item que não existe. A conferência do item só acontecia pelo
 * caminho da referência, e o funil à mão não tem item nenhum para conferir: o
 * resultado da consulta ao banco externo não acompanha a conversa
 * (`lib/ai/runtime/serialize.ts` resume `linhas` a uma contagem) e o
 * `McpContext` não carrega a conversa — o único portador da referência são os
 * argumentos da própria chamada.
 *
 * O funil, porém, é um portador: quando ele é o `destino_do_interesse` de uma
 * receita ATIVA, o negócio só pode significar "o cliente escolheu um item
 * daquela receita" — e aí o item é obrigatório. Fora do turno (rota MCP,
 * integração), ou num funil que não é destino de receita, a criação manual
 * continua permitida e deixa o registro `DECLARACAO_SEM_ITEM`.
 */
export async function completarDestinoDoNegocio(
  admin: SupabaseClient,
  organizationId: string,
  args: Record<string, unknown>,
  contexto: ContextoDaCriacao = {},
): Promise<DestinoCompletado> {
  const temFunil = typeof args.pipeline_id === "string" && args.pipeline_id !== "";
  const temEtapa = typeof args.stage_id === "string" && args.stage_id !== "";
  if (temFunil && temEtapa) {
    if (typeof args.referencia_externa === "string") {
      return conferirItem(admin, organizationId, args.referencia_externa);
    }
    return conferirItemDoFunilAMao(admin, organizationId, args, contexto);
  }

  if (temFunil !== temEtapa) {
    return {
      ok: false,
      resposta: {
        erro: "funil_e_etapa_juntos",
        mensagem: "informe pipeline_id e stage_id juntos, ou nenhum dos dois junto com referencia_externa.",
      },
    };
  }
  if (typeof args.referencia_externa !== "string") {
    return {
      ok: false,
      resposta: {
        erro: "funil_obrigatorio",
        mensagem:
          "informe pipeline_id e stage_id, ou a referencia_externa de um item cuja receita tem funil de destino configurado.",
      },
    };
  }

  const achado = await destinoPelaReferencia(admin, organizationId, args.referencia_externa);
  if (!achado.ok) {
    return { ok: false, resposta: { erro: achado.motivo, mensagem: achado.mensagem } };
  }
  const item = await conferirItem(admin, organizationId, args.referencia_externa);
  if (!item.ok) return item;
  args.pipeline_id = achado.destino.pipeline_id;
  args.stage_id = achado.destino.stage_id;
  return { ok: true };
}

/**
 * O FUNIL À MÃO CONFERE O ITEM — pelo funil, quando não há referência.
 *
 * O funil que é `destino_do_interesse` de uma receita ativa diz qual receita
 * está em jogo; o item, não. Num turno de conversa, o negócio nesse funil só
 * pode ser o interesse num item que o cliente viu — e sem a referência não há
 * como conferir que ele existe. Aí a criação é RECUSADA com o caminho de
 * correção (os dois lados legítimos: passar a referência, ou passar a conversa
 * para a equipe).
 *
 * Fora do turno, ou num funil que não é destino de receita, nada é recusado: a
 * criação manual de verdade continua de pé e leva o registro
 * `DECLARACAO_SEM_ITEM` — o silêncio era o defeito, não a criação.
 */
async function conferirItemDoFunilAMao(
  admin: SupabaseClient,
  organizationId: string,
  args: Record<string, unknown>,
  contexto: ContextoDaCriacao,
): Promise<DestinoCompletado> {
  const destinos = await destinosAtivosDaOrganizacao(admin, organizationId);
  // Não saber não é motivo para bloquear: banco fora ou receitas corrompidas
  // segue como hoje, com o registro de que o item não foi conferido.
  if (destinos === null) return { ok: true, declaracao: DECLARACAO_SEM_ITEM };
  // Organização que não usa receita: nada muda, nem o registro.
  if (destinos.length === 0) return { ok: true };

  const doFunil = destinos.find(
    (d) => d.pipeline_id === args.pipeline_id && d.stage_id === args.stage_id,
  );
  if (!doFunil) return { ok: true, declaracao: DECLARACAO_SEM_ITEM };
  if (contexto.turnoComContato === true) {
    return {
      ok: false,
      resposta: {
        erro: "item_obrigatorio",
        mensagem:
          `este funil é o destino do interesse de um item da receita "${doFunil.receita}", e o negócio não ` +
          "nasce sem o item conferido. Se o cliente escolheu um item que você mostrou, chame crm_create_lead " +
          "com referencia_externa no formato <receita>:<código>, usando o código que crm_consultar_receita " +
          "devolveu — não invente. Se o negócio não é sobre um item que o cliente viu, não abra por conta " +
          "própria: chame crm_request_human_handoff e diga ao cliente que a equipe dará continuidade.",
      },
    };
  }
  return { ok: true, declaracao: DECLARACAO_SEM_ITEM };
}

/**
 * Os destinos configurados nas instâncias ATIVAS das conexões ativas da
 * organização. `null` = não foi possível saber (conexões ilegíveis) — quem chama
 * escolhe não bloquear por isso.
 */
async function destinosAtivosDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ receita: string; pipeline_id: string; stage_id: string }[] | null> {
  const { data, error } = await admin
    .from("external_db_connections")
    .select("receitas")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  if (error) return null;
  const destinos: { receita: string; pipeline_id: string; stage_id: string }[] = [];
  for (const conexao of (data ?? []) as { receitas: unknown }[]) {
    const lida = lerReceitasDoBanco(conexao.receitas);
    if (!lida.ok) continue;
    for (const instancia of lida.instancias) {
      if (!instancia.ativa || !instancia.destino_do_interesse) continue;
      destinos.push({
        receita: instancia.receita,
        pipeline_id: instancia.destino_do_interesse.pipeline_id,
        stage_id: instancia.destino_do_interesse.stage_id,
      });
    }
  }
  return destinos;
}

// ponytail: no turno do agente o wrapper e o handler chamam `completarDestinoDoNegocio`,
// então o item é conferido duas vezes (uma leitura de 1 linha cada); juntar
// as duas chamadas só se a latência do banco de origem pesar.
async function conferirItem(
  admin: SupabaseClient,
  organizationId: string,
  referencia: unknown,
): Promise<{ ok: true } | { ok: false; resposta: Record<string, unknown> }> {
  if (referencia === undefined) return { ok: true };
  const item = await conferirItemDaReferencia(admin, organizationId, String(referencia));
  return item.ok ? item : { ok: false, resposta: { erro: item.motivo, mensagem: item.mensagem } };
}
