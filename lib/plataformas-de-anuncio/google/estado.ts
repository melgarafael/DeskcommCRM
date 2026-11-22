/**
 * O `state` do OAuth do Google Ads — assinado, com prazo, carregando quem
 * pediu a conexão.
 *
 * Mesma construção de `lib/agenda/google/estado.ts` (HMAC-SHA256, prazo
 * curto, comparação em tempo constante) — duplicada aqui em vez de
 * importada de propósito: são dois eixos sem relação (agenda de pessoa vs.
 * conta de anúncios de organização), e uma dependência cruzada entre eles
 * surpreenderia quem for mexer num sem saber que existe o outro. É a mesma
 * decisão que já separa `lib/nuvemshop/state.ts` do irmão da Agenda.
 *
 * A organização, o admin e a sessão viajam assinados. Na conexão de relatórios,
 * o state também identifica o anunciante que o admin pretende consultar.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApiDeConversaoGoogle } from "../types";
import { contaDeRelatorio, type ContaDeRelatorio } from "./conta-de-relatorio";

export const VALIDADE_DO_ESTADO_MS = 10 * 60 * 1000;

const TAMANHO_MINIMO_DO_SEGREDO = 16;

export interface EstadoDaConexaoDeAds {
  api: ApiDeConversaoGoogle;
  organizationId: string;
  userId: string;
  nonce: string;
  expiraEmMs: number;
  /** Sessão de quem iniciou: a régua de suporte do callback confere por ela. */
  authSessionId?: string;
  relatorio?: ContaDeRelatorio;
}

function assinar(carga: string, segredo: string): Buffer {
  return createHmac("sha256", segredo).update(carga, "utf8").digest();
}

function conferirSegredo(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new Error(
      "INTERNAL_SECRET ausente ou curto demais: sem ele o retorno do Google não tem como ser verificado",
    );
  }
  return s;
}

export function emitirEstado(
  dados: Pick<EstadoDaConexaoDeAds, "organizationId" | "userId" | "authSessionId" | "relatorio"> & { api?: ApiDeConversaoGoogle },
  opcoes: { segredo: string; agora: Date; nonce?: string; validadeMs?: number },
): string {
  const segredo = conferirSegredo(opcoes.segredo);
  const organizationId = dados.organizationId?.trim() ?? "";
  const userId = dados.userId?.trim() ?? "";
  if (!organizationId || !userId) {
    throw new Error("state precisa de organizationId e userId");
  }
  if (organizationId.includes(".") || userId.includes(".")) {
    throw new Error(
      "organizationId/userId com ponto: o separador da carga do state não sobreviveria",
    );
  }

  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const expira = opcoes.agora.getTime() + (opcoes.validadeMs ?? VALIDADE_DO_ESTADO_MS);
  const sessao = dados.authSessionId ? `.${dados.authSessionId}` : "";
  let carga = `${organizationId}.${userId}.${nonce}.${expira}.${dados.api ?? "google_ads"}${sessao}`;
  if (dados.relatorio) {
    if (!dados.authSessionId || dados.api !== "google_ads") throw new Error("Sessão de relatório inválida");
    const conta = contaDeRelatorio.parse(dados.relatorio);
    carga += `.${Buffer.from(JSON.stringify(conta), "utf8").toString("base64url")}`;
  }
  const assinatura = assinar(carga, segredo).toString("hex");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinatura}`;
}

/**
 * Devolve o conteúdo do `state` quando ele é nosso e ainda vale; `null` em
 * qualquer outro caso — mesma disciplina do irmão: um `null` só, nunca o
 * motivo detalhado na resposta ao navegador.
 */
export function verificarEstado(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDaConexaoDeAds | null {
  if (!token) return null;
  const segredo = conferirSegredo(opcoes.segredo);

  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [cargaCodificada, assinaturaHex] = partes;
  if (!cargaCodificada || !assinaturaHex) return null;

  let carga: string;
  try {
    carga = Buffer.from(cargaCodificada, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const esperada = assinar(carga, segredo);
  const recebida = Buffer.from(assinaturaHex, "hex");
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  const campos = carga.split(".");
  if (campos.length < 4 || campos.length > 7) return null;
  const [organizationId, userId, nonce, expiraTexto, api = "google_ads", authSessionId, conta] = campos;
  if (api !== "google_ads" && api !== "data_manager") return null;
  const expiraEmMs = Number(expiraTexto);
  if (!organizationId || !userId || !nonce || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;

  const estado: EstadoDaConexaoDeAds = { organizationId, userId, nonce, expiraEmMs, api, ...(authSessionId ? { authSessionId } : {}) };
  if (conta !== undefined) {
    if (api !== "google_ads" || !authSessionId) return null;
    try {
      estado.relatorio = contaDeRelatorio.parse(JSON.parse(Buffer.from(conta, "base64url").toString("utf8")));
    } catch {
      return null;
    }
  }
  return estado;
}
