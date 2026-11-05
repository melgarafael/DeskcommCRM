/**
 * A ÚNICA porta que grava `conversations.sector_id` — e agora ela serve a três
 * atores, não a um.
 *
 * ─── Por que este arquivo existe (#3881) ────────────────────────────────────
 *
 * A 9062 abriu a escrita do setor numa rota só, `PUT /api/v1/conversations/[id]/sector`,
 * com a sessão do atendente e a RLS de sempre. A #3881 pede que o AGENTE DE IA e
 * as AUTOMAÇÕES também escolham a fila — a triagem da agência sabe dizer que a
 * conversa é "viagens internacionais", e até hoje essa informação morria no
 * prompt porque não havia por onde gravar.
 *
 * Copiar a regra para cada ator novo seria o defeito que a #3479 mediu (duas
 * réguas de dono divergindo na primeira mudança). Então a régua desceu para cá:
 * a rota, a ferramenta `crm_set_conversation_sector` e a ação `define_sector`
 * chamam ESTA função. O que muda entre eles é só o cliente de banco (sessão ×
 * service role) e a origem auditada.
 *
 * ─── O que NÃO se afrouxou ──────────────────────────────────────────────────
 *
 * Nenhuma policy mudou: a RLS de `conversations` continua a de sempre. Quem
 * escreve com a sessão passa pelas policies; quem escreve como serviço (IA e
 * automação, que não têm sessão) passa por aqui, com três cercas explícitas —
 * organização vinda de fonte confiável (nunca do payload), conversa conferida
 * e setor conferido DENTRO da organização — e deixa rastro em `api_audit_log`.
 *
 * ─── A regra de precedência (manual × IA), declarada ────────────────────────
 *
 * A conversa carrega a marca `metadata.setor_origem` = `manual` | `ia` |
 * `automacao`. A regra é:
 *
 *   1. Setor gravado por PESSOA (`manual`) não é sobrescrito por IA nem por
 *      automação — a recusa é `setor_manual_preservado`, não uma escrita muda.
 *      Só passa com `sobrescreverSetorManual: true`, que a ferramenta e a ação
 *      expõem como opção DESLIGADA por padrão.
 *   2. Setor que a própria IA/automação gravou pode ser reclassificado por elas
 *      (é o caso da triagem que erra e volta atrás) e por pessoa, sempre.
 *   3. Conversa SEM setor é livre para qualquer ator.
 *   4. Conversa com setor e SEM marca nasceu antes desta fatia: a origem é
 *      DESCONHECIDA, e o desconhecido conta como manual. Errar para o lado de
 *      preservar custa uma classificação a menos; errar para o outro lado
 *      apagaria, calado, a escolha que uma pessoa fez à mão.
 *
 * A marca mora em `metadata` porque é estado por conversa e o Inbox já projeta
 * esse jsonb: nenhuma migration foi necessária. Os dois outros escritores de
 * `conversations.metadata` (`cron/rodizio-devolucao` e `handoff-tecnico`)
 * mesclam a partir da linha lida, então a marca sobrevive a eles.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

/** A chave da marca de origem dentro de `conversations.metadata`. */
export const CHAVE_DA_ORIGEM_DO_SETOR = "setor_origem";

/** Quem escolheu a fila. `manual` é gente; os outros dois não têm sessão. */
export type OrigemDoSetor = "manual" | "ia" | "automacao";

/** Os status em que a conversa ainda aceita receber fila. */
const STATUS_ENCERRADOS = ["closed", "archived"] as const;

/** Os status em que a conversa sem dono volta para a distribuição. */
const STATUS_NA_FILA = ["open", "pending"] as const;

/** Por que a escrita foi recusada. Cada motivo tem um texto próprio na borda. */
export type RecusaDoSetor =
  | "conversa_nao_encontrada"
  | "setor_inexistente"
  | "conversa_encerrada"
  | "setor_manual_preservado"
  /** Só a rota humana limpa a fila; IA e automação não gravam nulo. */
  | "limpeza_nao_permitida"
  /** Não `modulo_desligado`: esse código já é do módulo Fluxos de atendimento
   *  no mapa da aba Atividade, e a frase dele falaria do módulo errado. */
  | "setores_desligados"
  | "falha_ao_gravar";

export type ResultadoDoSetor =
  | {
      ok: true;
      /** Setor de antes (null = a conversa não tinha fila). */
      de: string | null;
      para: string | null;
      /** true quando o valor gravado é diferente do que estava lá. */
      mudou: boolean;
      /** true quando a conversa sem dono voltou para a distribuição do setor. */
      redistribuiu: boolean;
    }
  | { ok: false; motivo: RecusaDoSetor; mensagem: string };

/**
 * Quem está escrevendo, para a auditoria. A IA e a automação não têm usuário:
 * `userId` fica nulo e a identidade vai em `metadata.actor_type`/`actor_id`,
 * igual ao que o servidor MCP já faz em `crm_assign_conversation`.
 */
export interface AtorDoSetor {
  tipo: "user" | "ai_agent" | "automacao" | "api_token";
  userId?: string | null;
  apiTokenId?: string | null;
  /** Id do agente ou da regra, quando houver. */
  id?: string | null;
}

export interface EntradaDoSetor {
  /** Cliente de LEITURA/ESCRITA: a sessão na rota, o de serviço na IA/automação. */
  db: SupabaseClient;
  /**
   * Cliente para a lista de setores e para o pedido de distribuição. Na rota é
   * o de serviço (a lista de setores é lida por ele desde a 0801); na IA e na
   * automação é o mesmo `db`.
   */
  admin?: SupabaseClient;
  organizationId: string;
  conversationId: string;
  /** `null` = limpar a fila. Permitido SÓ na origem `manual` (a rota humana). */
  sectorId: string | null;
  origem: OrigemDoSetor;
  /** Opt-in explícito: sobrescreve o setor que uma PESSOA escolheu. */
  sobrescreverSetorManual?: boolean;
  ator: AtorDoSetor;
  requestId?: string | null;
  /**
   * A rota já conferiu o módulo antes de autorizar (404 antes do 403). Evita a
   * segunda consulta no caminho quente dela; IA e automação deixam o default.
   */
  moduloJaConferido?: boolean;
}

/** A linha que a régua precisa ler da conversa. */
interface ConversaDoSetor {
  id: string;
  status: string | null;
  assigned_to_user_id: string | null;
  sector_id: string | null;
  metadata: unknown;
}

/**
 * A origem GRAVADA na conversa. O 4º item da regra de precedência mora aqui:
 * setor preenchido sem marca = escrito antes da marca existir = conta como
 * manual.
 */
export function origemGravada(conversa: {
  sector_id: string | null;
  metadata: unknown;
}): OrigemDoSetor | null {
  const metadata =
    conversa.metadata && typeof conversa.metadata === "object"
      ? (conversa.metadata as Record<string, unknown>)
      : {};
  const marca = metadata[CHAVE_DA_ORIGEM_DO_SETOR];
  if (marca === "manual" || marca === "ia" || marca === "automacao") return marca;
  return conversa.sector_id ? "manual" : null;
}

/**
 * A IA/automação pode sobrescrever este setor?
 *
 * Devolve `true` quando não há nada a preservar (sem setor, ou setor da própria
 * IA/automação) ou quando quem chama pediu a sobrescrita explicitamente.
 */
export function podeSobrescreverSetorManual(
  conversa: { sector_id: string | null; metadata: unknown },
  origem: OrigemDoSetor,
  sobrescreverSetorManual: boolean,
): boolean {
  if (origem === "manual") return true;
  if (sobrescreverSetorManual) return true;
  if (!conversa.sector_id) return true;
  return origemGravada(conversa) !== "manual";
}

/**
 * Metadados da auditoria — o "quem, de qual setor para qual" que a tela de
 * auditoria mostra. `de`/`para` são ids: o nome do setor muda, o id não.
 */
function metadadosDaAuditoria(
  entrada: EntradaDoSetor,
  de: string | null,
  para: string | null,
  redistribuiu: boolean,
  mudou: boolean,
): Record<string, unknown> {
  return {
    de,
    para,
    redistribuiu,
    mudou,
    origem: entrada.origem,
    actor_type: entrada.ator.tipo,
    ...(entrada.ator.id ? { actor_id: entrada.ator.id } : {}),
  };
}

/**
 * Grava a fila da conversa. Idempotente: pedir o setor que já está lá devolve
 * `ok` com `mudou: false` e não audita de novo (a IA pode repetir a chamada em
 * todo turno; auditoria repetida viraria ruído, não rastro).
 */
export async function definirSetorDaConversa(entrada: EntradaDoSetor): Promise<ResultadoDoSetor> {
  const { db, organizationId, conversationId, sectorId, origem } = entrada;
  const admin = entrada.admin ?? db;

  if (!entrada.moduloJaConferido) {
    // Módulo opcional da instalação (doc 213): desligado, setor não existe —
    // nem para ler, nem para escrever. A IA e a automação recusam aqui, e não
    // tentam gravar uma coluna que ninguém usa.
    if (!(await moduloLigado(admin, "setores"))) {
      return { ok: false, motivo: "setores_desligados", mensagem: "Setores estão desligados nesta instalação." };
    }
  }

  // A conversa TEM de ser desta organização: o `organization_id` vem da fonte
  // confiável do chamador (sessão/contexto), nunca do payload que a IA escreve.
  // Com o cliente de serviço isto é a única barreira — a RLS não está no caminho.
  const { data: conversaCrua, error: erroConversa } = await db
    .from("conversations")
    .select("id, status, assigned_to_user_id, sector_id, metadata")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroConversa) {
    return { ok: false, motivo: "falha_ao_gravar", mensagem: erroConversa.message };
  }
  if (!conversaCrua) {
    return { ok: false, motivo: "conversa_nao_encontrada", mensagem: "Conversa não encontrada." };
  }
  const conversa = conversaCrua as ConversaDoSetor;

  if (STATUS_ENCERRADOS.includes(conversa.status as (typeof STATUS_ENCERRADOS)[number])) {
    // Conversa encerrada não recebe fila: reclassificar o que já acabou só
    // produz relatório errado e, no caso da IA, reabre um atendimento que
    // ninguém está olhando.
    return {
      ok: false,
      motivo: "conversa_encerrada",
      mensagem: "A conversa está encerrada e não aceita mais setor.",
    };
  }

  // O setor tem de existir NESTA organização. A FK composta do banco também
  // recusaria o contrário, mas ela recusa como erro de constraint (500 opaco) e
  // NÃO é a mesma pergunta: o que queremos é "esta pessoa/agente escolheu uma
  // fila que não existe aqui" — e isso é recusa nomeada, nunca `sector_id` nulo.
  if (sectorId === null) {
    // Limpar a fila é gesto de gente na tela. A IA que devolve nulo por erro de
    // preenchimento não pode apagar a classificação da conversa — a recusa
    // existe justamente para o nulo não virar escrita.
    if (origem !== "manual") {
      return {
        ok: false,
        motivo: "limpeza_nao_permitida",
        mensagem: "Informe um setor existente: a IA e a automação não limpam o setor da conversa.",
      };
    }
  } else {
    const { data: setor, error: erroSetor } = await admin
      .from("attendant_sectors")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", sectorId)
      .maybeSingle();
    if (erroSetor) {
      return { ok: false, motivo: "falha_ao_gravar", mensagem: erroSetor.message };
    }
    if (!setor) {
      return { ok: false, motivo: "setor_inexistente", mensagem: "Setor inexistente nesta organização." };
    }
  }

  const de = conversa.sector_id ?? null;
  const mudou = de !== sectorId;

  // Auditoria: o mesmo evento da rota (a tela de auditoria não aprende um
  // segundo nome para o mesmo fato), com `origem` dizendo quem escolheu. A rota
  // humana audita SEMPRE, inclusive quando o setor não mudou — é o contrato de
  // antes desta fatia e ele fica; IA e automação auditam só a mudança real, para
  // uma triagem que repete a chamada em todo turno não encher o log de ruído.
  const auditar = (redistribuiu: boolean) =>
    audit({
      action: "conversation.sector_changed",
      actorUserId: entrada.ator.userId ?? null,
      actorApiTokenId: entrada.ator.apiTokenId ?? null,
      organizationId,
      resourceType: "conversation",
      resourceId: conversationId,
      requestId: entrada.requestId ?? null,
      metadata: metadadosDaAuditoria(entrada, de, sectorId, redistribuiu, mudou),
    });

  if (!mudou) {
    if (origem === "manual") await auditar(false);
    return { ok: true, de, para: sectorId, mudou: false, redistribuiu: false };
  }

  if (!podeSobrescreverSetorManual(conversa, origem, entrada.sobrescreverSetorManual === true)) {
    return {
      ok: false,
      motivo: "setor_manual_preservado",
      mensagem:
        "O setor desta conversa foi definido por uma pessoa e não é sobrescrito automaticamente.",
    };
  }

  // A marca anda junto com a coluna: os dois na MESMA escrita, senão a próxima
  // chamada leria um setor novo com a marca velha e a precedência erraria.
  const metadata =
    conversa.metadata && typeof conversa.metadata === "object"
      ? (conversa.metadata as Record<string, unknown>)
      : {};
  const { data: atualizada, error: erroUpdate } = await db
    .from("conversations")
    .update({ sector_id: sectorId, metadata: { ...metadata, [CHAVE_DA_ORIGEM_DO_SETOR]: origem } })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select("id, sector_id, assigned_to_user_id, status")
    .maybeSingle();
  if (erroUpdate) {
    return { ok: false, motivo: "falha_ao_gravar", mensagem: erroUpdate.message };
  }
  if (!atualizada) {
    // Sumiu entre a leitura e a escrita (ou a RLS de UPDATE não deixou): não é
    // sucesso, e não é 404 de leitura — é a escrita que não alcançou a linha.
    return { ok: false, motivo: "falha_ao_gravar", mensagem: "Nenhuma linha foi atualizada." };
  }

  // Sem dono e em aberto: o vínculo novo pede distribuição. A RPC é a MESMA que
  // o trigger de atribuição usa (`fn_request_channel_routing`) — não inventamos
  // um segundo caminho para a fila nascer. Conversa COM dono continua com ele:
  // trocar de fila não é transferência.
  let redistribuiu = false;
  if (!atualizada.assigned_to_user_id && STATUS_NA_FILA.includes(String(atualizada.status) as (typeof STATUS_NA_FILA)[number])) {
    const { error: erroFila } = await admin.rpc("fn_request_channel_routing", {
      p_org: organizationId,
      p_conversation: conversationId,
    });
    if (erroFila) {
      // A fila já está gravada; o evento de distribuição é o que faltou, e o
      // próximo ciclo de atribuição alcança a conversa. Não desfazemos a
      // escrita por causa disso — mas o rastro fica.
      logger.error("conversation.sector: fn_request_channel_routing falhou", {
        message: erroFila.message,
      });
    } else {
      redistribuiu = true;
    }
  }

  // Auditoria — ver `auditar` acima: o mesmo evento, com a origem de quem
  // escolheu.
  await auditar(redistribuiu);

  return { ok: true, de, para: sectorId, mudou: true, redistribuiu };
}
