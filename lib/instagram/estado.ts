/**
 * O `state` do OAuth do Instagram — assinado, com prazo, carregando O LEAD.
 *
 * Mesma construção de `lib/agenda/google/estado.ts` (HMAC-SHA256, prazo curto,
 * comparação em tempo constante), com a MESMA correção em relação ao
 * precedente da Nuvemshop: o segredo é injetado e a ausência/curtice dele
 * LANÇA na emissão — cair para uma chave aleatória por processo faria o
 * `state` emitido por uma réplica não validar noutra, num sintoma
 * intermitente sem nada no log que aponte a causa.
 *
 * ─── Por que CONTATO, não usuário ───────────────────────────────────────────
 * Quem conecta aqui é O LEAD, não um membro da equipe: não há sessão nossa
 * para amarrar. `organizationId` + `contactId` bastam para saber de quem é a
 * conta Instagram que está voltando.
 *
 * ─── Por que NÃO existe cookie de vínculo nem tabela de nonce, ao contrário
 *     do fluxo do Google ───────────────────────────────────────────────────
 * O vínculo do Google prova "quem voltou é quem saiu" porque a IDENTIDADE
 * importa: a agenda teria que saber sem sombra de dúvida de qual membro da
 * equipe é. Aqui o pior cenário de alguém completar o fluxo com uma conta
 * Instagram diferente da pretendida é o MESMO de qualquer link mágico
 * (recuperação de senha, convite de time): o contato fica com uma conexão
 * errada, que se resolve reconectando — não há sessão nem dado de terceiro
 * para sequestrar. O link em si (enviado só pelo WhatsApp do lead) é o
 * segredo, como em qualquer magic link. Fechar isso por completo exigiria uma
 * tabela de nonce de uso único (estado, não pertence a este módulo) — deixado
 * como próximo passo se a fraude aparecer, não antecipado sem sinal dela.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Dez minutos: o tempo de atravessar a tela de consentimento do Instagram, e nada além. */
export const VALIDADE_DO_ESTADO_MS = 10 * 60 * 1000;

/** Abaixo disto, a assinatura não protege nada — melhor recusar que fingir. */
const TAMANHO_MINIMO_DO_SEGREDO = 16;

export interface EstadoDaConexao {
  organizationId: string;
  contactId: string;
  nonce: string;
  expiraEmMs: number;
}

function assinar(carga: string, segredo: string): Buffer {
  return createHmac("sha256", segredo).update(carga, "utf8").digest();
}

function conferirSegredo(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new Error(
      "INTERNAL_SECRET ausente ou curto demais: sem ele o retorno do Instagram não tem como ser verificado",
    );
  }
  return s;
}

export function emitirEstado(
  dados: { organizationId: string; contactId: string },
  opcoes: { segredo: string; agora: Date; nonce?: string; validadeMs?: number },
): string {
  const segredo = conferirSegredo(opcoes.segredo);
  const organizationId = dados.organizationId?.trim() ?? "";
  const contactId = dados.contactId?.trim() ?? "";
  if (!organizationId || !contactId) {
    throw new Error("state precisa de organizationId e contactId: a conexão é de um lead, não da conta");
  }
  // O ponto é o separador da carga. Um id que o contenha partiria o campo em
  // dois e a verificação leria lixo como se fosse identidade.
  if (organizationId.includes(".") || contactId.includes(".")) {
    throw new Error("organizationId/contactId com ponto: o separador da carga do state não sobreviveria");
  }

  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const expira = opcoes.agora.getTime() + (opcoes.validadeMs ?? VALIDADE_DO_ESTADO_MS);
  const carga = `${organizationId}.${contactId}.${nonce}.${expira}`;
  const assinatura = assinar(carga, segredo).toString("hex");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinatura}`;
}

/**
 * Devolve o conteúdo do `state` quando ele é nosso e ainda vale; `null` em
 * qualquer outro caso — assinatura errada, prazo vencido, formato estranho.
 *
 * Um único `null` para todas as recusas é de propósito: distinguir "assinatura
 * inválida" de "expirado" na resposta entregaria a um atacante a diferença que
 * ele precisa para calibrar.
 */
export function verificarEstado(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDaConexao | null {
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
  let recebida: Buffer;
  try {
    recebida = Buffer.from(assinaturaHex, "hex");
  } catch {
    return null;
  }
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  const campos = carga.split(".");
  if (campos.length !== 4) return null;
  const [organizationId, contactId, nonce, expiraTexto] = campos;
  const expiraEmMs = Number(expiraTexto);
  if (!organizationId || !contactId || !nonce || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;

  return { organizationId, contactId, nonce, expiraEmMs };
}
