/**
 * A leitura dos eventos que o módulo `connected` busca por cursor (spec 33, F5).
 *
 * O módulo prova quem é com a MESMA assinatura da busca de token (`provarModulo`), então a leitura vale
 * mesmo depois de o token ter sido revogado. Aqui ficam: a autorização (`fn_extensions_events_allowed`), o
 * cursor opaco, o reconhecimento (`fn_extensions_events_ack`) e a leitura (`fn_extensions_events_read`).
 *
 * ── Regras que não mudam ────────────────────────────────────────────────────
 *
 * - A ORGANIZAÇÃO vem dos cabeçalhos ASSINADOS (o HMAC a cobre) e o banco confere o par organização ×
 *   instalação. O módulo nunca escolhe a organização além de assiná-la, e o corpo/consulta da requisição
 *   não carrega organização nenhuma.
 * - O cursor é opaco e ASSINADO: liga organização, instalação e posição. Cursor adulterado, de outra
 *   organização ou de outra instalação é `cursor_invalido` — o módulo nunca lê a partir de uma posição que
 *   ele mesmo escolheu. Só se distingue DEPOIS de autenticado: antes disso toda recusa é a mesma.
 * - Toda recusa de autenticação/autorização (prova, par sem vínculo, `extension_events_forbidden` do banco,
 *   módulo desativado há mais de 30 dias) é `recusado`, igual à busca do token. Falha NOSSA é `indisponivel`.
 * - O cursor RECEBIDO é o reconhecimento do anterior: uma chamada de `ack` por requisição, ANTES de ler.
 *   Sem cursor não há ack. O ack só avança (o banco nunca regride o cursor).
 * - Só `createAdminClient().rpc(...)`: as tabelas de eventos só são lidas por este arquivo, pelas funções.
 * - Só identificadores nos eventos. Nada aqui vai a log com segredo, assinatura, nonce ou cursor.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { provarModulo, type CabecalhosDaBusca } from "./prova-do-modulo";

export const LIMITE_PADRAO_DE_EVENTOS = 50;
export const LIMITE_MAXIMO_DE_EVENTOS = 100;

/** `<carga em base64url>.<HMAC SHA-256 em hex>`: o que cabe numa query string sem escape. */
const FORMATO_DO_CURSOR = /^[A-Za-z0-9_-]{20,200}\.[0-9a-f]{64}$/;
/** Separa o uso desta chave de qualquer outro que reaproveite o mesmo segredo do servidor. */
const CONTEXTO_DA_CHAVE = "module-events-cursor:v1";

export interface EventoDoModulo {
  id: number;
  kind: "contact_anonymized" | "module_disabled" | "organization_suspended";
  subject_id: string | null;
  installation_id: string | null;
  occurred_at: string;
}

export type ResultadoDaLeitura =
  | { ok: true; events: EventoDoModulo[]; next_cursor: string | null; has_more: boolean }
  | { ok: false; motivo: "recusado" | "indisponivel" | "cursor_invalido" | "limite_invalido" };

function chaveDoCursor(): Buffer {
  const segredo = env.INTERNAL_SECRET?.trim() ?? "";
  if (segredo.length < 16) {
    throw new Error("INTERNAL_SECRET ausente ou curto demais: o cursor de eventos não teria como ser verificado");
  }
  return createHmac("sha256", segredo).update(CONTEXTO_DA_CHAVE).digest();
}

function assinarCarga(carga: string): Buffer {
  return createHmac("sha256", chaveDoCursor()).update(carga, "utf8").digest();
}

/** Cursor para a posição `posicao` (id do último evento entregue) deste par organização × instalação. */
export function emitirCursorDeEventos(organizationId: string, installationId: string, posicao: number): string {
  const carga = `${organizationId}.${installationId}.${posicao}`;
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinarCarga(carga).toString("hex")}`;
}

/**
 * A posição do cursor, ou `null` para tudo o que não for um cursor nosso, íntegro e DESTE par
 * organização × instalação. Nunca lança por entrada ruim (lança só se o segredo do servidor faltar).
 */
export function lerCursorDeEventos(
  cursor: string,
  organizationId: string,
  installationId: string,
): number | null {
  if (!FORMATO_DO_CURSOR.test(cursor)) return null;
  const [codificada = "", assinaturaHex = ""] = cursor.split(".");
  const carga = Buffer.from(codificada, "base64url").toString("utf8");
  const esperada = assinarCarga(carga);
  const recebida = Buffer.from(assinaturaHex, "hex");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;
  const partes = carga.split(".");
  if (partes.length !== 3) return null;
  const [org = "", inst = "", pos = ""] = partes;
  if (org !== organizationId || inst !== installationId) return null;
  if (!/^[0-9]{1,15}$/.test(pos)) return null;
  const posicao = Number(pos);
  return Number.isSafeInteger(posicao) ? posicao : null;
}

function recusado(motivo: string, installationId: string): ResultadoDaLeitura {
  logger.warn("[extensions] leitura de eventos recusada", { motivo, installation_id: installationId });
  return { ok: false, motivo: "recusado" };
}

function indisponivel(motivo: string, installationId: string, dbCode?: string | null): ResultadoDaLeitura {
  logger.warn("[extensions] leitura de eventos não concluída", {
    motivo,
    installation_id: installationId,
    db_code: dbCode ?? null,
  });
  return { ok: false, motivo: "indisponivel" };
}

/** O banco recusou o par (`extension_events_forbidden`): é autorização, não falha nossa. */
function ehRecusaDoBanco(error: { message?: string | null }): boolean {
  return (error.message ?? "").includes("extension_events_forbidden");
}

/**
 * Passos depois do formato e do rate limit (que são da rota): prova → autorização → cursor → ack → leitura.
 * `limite` é conferido DEPOIS da prova (1..100) para a requisição malformada não distinguir nada antes de
 * autenticar. `agoraMs` existe para o teste fixar o relógio.
 */
export async function lerEventosDoModulo(
  entrada: CabecalhosDaBusca,
  cursor: string | null,
  limite: number,
  _requestId: string,
  agoraMs: number = Date.now(),
): Promise<ResultadoDaLeitura> {
  const { installationId, organizationId } = entrada;

  // 1. prova de identidade (carimbo → segredo → assinatura → nonce).
  const prova = await provarModulo(entrada, agoraMs);
  if (!prova.ok) {
    return prova.motivo === "recusado"
      ? recusado(prova.detalhe, installationId)
      : indisponivel(prova.detalhe, installationId, prova.dbCode);
  }

  const admin = createAdminClient();

  // 2. autorização: o par organização × instalação, conferido pelo banco (regra D2: vínculo ligado OU
  // desativado há menos de 30 dias).
  const permitido = await admin.rpc("fn_extensions_events_allowed", {
    p_organization: organizationId,
    p_installation: installationId,
  });
  if (permitido.error) return indisponivel("autorizacao_nao_lida", installationId, permitido.error.code);
  if (permitido.data !== true) return recusado("nao_autorizado", installationId);

  // 3. só agora o que o módulo mandou além da prova: limite e cursor.
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO_DE_EVENTOS) {
    return { ok: false, motivo: "limite_invalido" };
  }
  let apos = 0;
  if (cursor !== null) {
    let lido: number | null;
    try {
      lido = lerCursorDeEventos(cursor, organizationId, installationId);
    } catch {
      // Segredo do servidor ausente: falha nossa, não do módulo.
      return indisponivel("chave_do_cursor", installationId);
    }
    if (lido === null) return { ok: false, motivo: "cursor_invalido" };
    apos = lido;

    // 4. o cursor recebido reconhece o que o módulo já leu. Uma vez por requisição, antes de ler.
    const ack = await admin.rpc("fn_extensions_events_ack", {
      p_organization: organizationId,
      p_installation: installationId,
      p_event_id: apos,
    });
    if (ack.error) {
      if (ehRecusaDoBanco(ack.error)) return recusado("nao_autorizado_no_ack", installationId);
      return indisponivel("ack_falhou", installationId, ack.error.code);
    }
  }

  // 5. leitura: o banco filtra pela organização e pelo par; o limite é cortado de novo lá dentro.
  const leitura = await admin.rpc("fn_extensions_events_read", {
    p_organization: organizationId,
    p_installation: installationId,
    p_after: apos,
    p_limit: limite,
  });
  if (leitura.error) {
    if (ehRecusaDoBanco(leitura.error)) return recusado("nao_autorizado_na_leitura", installationId);
    return indisponivel("leitura_falhou", installationId, leitura.error.code);
  }
  const corpo = leitura.data as {
    events?: EventoDoModulo[];
    last_id?: number | string;
    has_more?: boolean;
  } | null;
  const ultimo = Number(corpo?.last_id);
  if (!corpo || !Array.isArray(corpo.events) || !Number.isSafeInteger(ultimo) || ultimo < apos) {
    return indisponivel("leitura_ilegivel", installationId);
  }

  // Sem nada para entregar e sem cursor de partida, não há posição a devolver.
  let proximo: string | null;
  try {
    proximo = ultimo > 0 ? emitirCursorDeEventos(organizationId, installationId, ultimo) : null;
  } catch {
    return indisponivel("chave_do_cursor", installationId);
  }
  return { ok: true, events: corpo.events, next_cursor: proximo, has_more: corpo.has_more === true };
}

// ── O atraso do módulo, para `/admin/extensoes` (F5 T3) ─────────────────────
//
// Só números e datas: a função do banco conta POR ORGANIZAÇÃO (eventos da mesma organização do cursor, com
// `id` maior que `last_event_id`; `module_disabled` só do par) e NÃO devolve qual organização é. Nada aqui
// identifica empresa: a tela do dono do servidor mostra o estado de cada vínculo, não o nome do cliente.

export const JANELA_DO_ATRASO_MS = 24 * 60 * 60 * 1000;

export interface AtrasoPorVinculo {
  /** Último evento lido; `null` se este vínculo nunca leu. */
  ultimoCursor: number | null;
  /** Quando leu pela última vez; `null` se nunca leu. */
  lidoEm: string | null;
  /** Quantos eventos faltam ler. */
  atraso: number;
  /** Destes, quantos são contatos anonimizados que o módulo ainda não apagou. */
  contatosPendentes: number;
  /** O mais antigo ainda não lido; `null` se em dia. */
  maisAntigoEm: string | null;
  /** Atraso e sem leitura há mais de 24 h (ou nunca leu e há evento com mais de 24 h). */
  atrasado: boolean;
}

function inteiro(v: unknown): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function dataOuNula(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/** Regra do selo "atrasado" (pura, para o teste fixar o relógio). */
export function estaAtrasado(
  v: { atraso: number; lidoEm: string | null; maisAntigoEm: string | null },
  agoraMs: number,
): boolean {
  if (v.atraso <= 0) return false;
  if (v.lidoEm !== null) return agoraMs - Date.parse(v.lidoEm) > JANELA_DO_ATRASO_MS;
  return v.maisAntigoEm !== null && agoraMs - Date.parse(v.maisAntigoEm) > JANELA_DO_ATRASO_MS;
}

/** Normaliza o jsonb do banco. Nunca lança por forma inesperada: linha ilegível é descartada. */
export function interpretarAtraso(bruto: unknown, agoraMs: number): AtrasoPorVinculo[] {
  if (!Array.isArray(bruto)) return [];
  const saida: AtrasoPorVinculo[] = [];
  for (const item of bruto) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const lidoEm = dataOuNula(r.last_read_at);
    const base = {
      ultimoCursor: lidoEm === null ? null : inteiro(r.last_event_id),
      lidoEm,
      atraso: inteiro(r.lag),
      contatosPendentes: inteiro(r.contacts_pending),
      maisAntigoEm: dataOuNula(r.oldest_unread_at),
    };
    saida.push({ ...base, atrasado: estaAtrasado(base, agoraMs) });
  }
  return saida;
}

/**
 * O atraso de uma instalação `connected`, um item por vínculo. Falha de leitura devolve `null` (a tela não
 * mostra número inventado); nunca lança.
 */
export async function lerAtrasoDoModulo(
  installationId: string,
  agoraMs: number = Date.now(),
): Promise<AtrasoPorVinculo[] | null> {
  const { data, error } = await createAdminClient().rpc("fn_extensions_events_lag", {
    p_installation: installationId,
  });
  if (error) {
    logger.warn("[extensions] atraso do módulo não lido", {
      installation_id: installationId,
      db_code: error.code ?? null,
    });
    return null;
  }
  return interpretarAtraso(data, agoraMs);
}
