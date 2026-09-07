/**
 * O `state` do OAuth do Google — assinado, com prazo, e carregando A PESSOA.
 *
 * ─── Por que não é o `state` da Nuvemshop ─────────────────────────────────
 *
 * A construção é a mesma de `lib/nuvemshop/state.ts` de propósito (HMAC-SHA256,
 * prazo curto, comparação em tempo constante) — o que muda é a carga. Lá basta
 * a organização: a loja é uma por tenant. Aqui a agenda é **por pessoa**
 * (`unique (organization_id, user_id, provider, account_email)`), então o
 * retorno do Google precisa dizer de quem é a agenda que acabou de ser
 * autorizada. Sem o `user_id` no `state`, o callback teria de adivinhar — e a
 * agenda de um atendente entraria como a de outro.
 *
 * ─── Duas diferenças deliberadas em relação ao precedente ─────────────────
 *
 * 1. **O segredo é injetado, não lido do ambiente.** A versão da Nuvemshop cai
 *    numa chave aleatória por processo quando `INTERNAL_SECRET` está curto.
 *    Numa VPS com mais de uma réplica isso significa que o `state` emitido por
 *    um processo não valida no outro — e o sintoma é "conectei e deu erro" de
 *    forma intermitente, sem nada no log que aponte a causa. Aqui a falta de
 *    segredo LANÇA na emissão, e quem chama transforma isso numa mensagem que
 *    nomeia a variável que falta.
 * 2. **O relógio é injetado.** Prazo é a metade da defesa que só se prova nas
 *    bordas, e uma função que lê o próprio relógio não tem bordas testáveis.
 *
 * ─── O que este arquivo NÃO resolve, e está declarado ─────────────────────
 *
 * O `nonce` é emitido e devolvido na verificação, mas ninguém o queima: dentro
 * do prazo, o mesmo `state` vale duas vezes. Fechar isso exige guardar o nonce
 * usado (Redis ou tabela), o que é estado — e estado não mora nesta camada.
 * Quem monta a rota do callback recebe o nonce justamente para poder queimá-lo.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Dez minutos: o tempo de atravessar a tela de consentimento, e nada além. */
export const VALIDADE_DO_ESTADO_MS = 10 * 60 * 1000;

/** Abaixo disto, a assinatura não protege nada — melhor recusar que fingir. */
const TAMANHO_MINIMO_DO_SEGREDO = 16;

export interface EstadoDaConexao {
  organizationId: string;
  userId: string;
  authSessionId?: string;
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
      "INTERNAL_SECRET ausente ou curto demais: sem ele o retorno do Google não tem como ser verificado",
    );
  }
  return s;
}

export function emitirEstado(
  dados: { organizationId: string; userId: string; authSessionId?: string },
  opcoes: { segredo: string; agora: Date; nonce?: string; validadeMs?: number },
): string {
  const segredo = conferirSegredo(opcoes.segredo);
  const organizationId = dados.organizationId?.trim() ?? "";
  const userId = dados.userId?.trim() ?? "";
  if (!organizationId || !userId) {
    throw new Error("state precisa de organizationId e userId: a agenda conectada é de uma pessoa, não da conta");
  }
  // O ponto é o separador da carga. Um id que o contenha partiria o campo em
  // dois e a verificação leria lixo como se fosse identidade.
  if (organizationId.includes(".") || userId.includes(".")) {
    throw new Error("organizationId/userId com ponto: o separador da carga do state não sobreviveria");
  }

  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const expira = opcoes.agora.getTime() + (opcoes.validadeMs ?? VALIDADE_DO_ESTADO_MS);
  const carga = `${organizationId}.${userId}.${nonce}.${expira}${dados.authSessionId ? `.${dados.authSessionId}` : ""}`;
  const assinatura = assinar(carga, segredo).toString("hex");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinatura}`;
}

/**
 * Devolve o conteúdo do `state` quando ele é nosso e ainda vale; `null` em
 * qualquer outro caso — assinatura errada, prazo vencido, formato estranho.
 *
 * Um único `null` para todas as recusas é de propósito: distinguir "assinatura
 * inválida" de "expirado" na resposta ao navegador entrega ao atacante a
 * diferença que ele precisa para calibrar. Quem chama sabe o suficiente —
 * recusar — e o motivo detalhado vive no log do servidor, não na URL.
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
  const recebida = Buffer.from(assinaturaHex, "hex");
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  const campos = carga.split(".");
  if (campos.length !== 4 && campos.length !== 5) return null;
  const [organizationId, userId, nonce, expiraTexto, authSessionId] = campos;
  const expiraEmMs = Number(expiraTexto);
  if (!organizationId || !userId || !nonce || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;

  return { organizationId, userId, nonce, expiraEmMs, ...(authSessionId ? { authSessionId } : {}) };
}
