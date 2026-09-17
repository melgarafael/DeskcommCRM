import type { ZodSchema } from "zod";

import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type RequestOpts = {
  schema?: ZodSchema<unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * O prazo de uma ESCRITA — o orçamento que o fim do retry tirou sem repor.
 *
 * ─── A conta ────────────────────────────────────────────────────────────────
 *
 * Enquanto método mutante era retentado, uma escrita tinha três tentativas de
 * `DEFAULT_TIMEOUT_MS` separadas pelo `backoffMs`: 10s + ~0,2s + 10s + ~0,4s +
 * 10s ≈ **30,6s** de parede até o cliente desistir de vez. O retry era errado
 * (executava a escrita de novo, e foi por isso que caiu — ver o bloco
 * `MUTATING_METHODS` no `catch` abaixo), mas ele também era, sem querer, o
 * ORÇAMENTO DE ESPERA de toda escrita do produto. Tirar a repetição sem repor a
 * espera cortou esse orçamento para 10s num único gesto, em toda mutação da
 * base — e ninguém mexeu no número.
 *
 * ─── O que isso quebrou, medido ─────────────────────────────────────────────
 *
 * CI `e2e` do lote, run 34876435491, `followup-dossie.spec.ts:190`. No trace:
 *
 *     POST /api/v1/ai/followups/enrollments/…/pause
 *     time 9999.558ms   _failureText net::ERR_ABORTED   1 tentativa
 *
 * 9999,558ms é o `DEFAULT_TIMEOUT_MS` cravado: quem desistiu foi o NAVEGADOR,
 * não o servidor. E a máquina não estava lenta — dos 16 testes `followup-*`
 * vizinhos no mesmo job, 15 correram MAIS RÁPIDO que no run verde da `main`
 * 34878063927 (builder:414 9,9s contra 11,7s; queue:153 8,9s contra 12,2s;
 * dossie:288 11,4s contra 14,6s), e o único mais lento foi builder:287, por
 * 1s. Foi uma paralisada isolada daquela escrita, do tipo que os 30s absorviam
 * e os 10s não absorvem mais.
 *
 * O que a pessoa via na tela, no frame seguinte ao corte: "Erro inesperado.
 * Tente novamente." sobre um dossiê ainda escrito "Ativo" — exatamente o
 * sintoma que o cabeçalho da migration 0243 descreve como o incidente de
 * 2026-09-12, e que ela consertou só do lado do banco (`lock_timeout` em
 * `authenticator`/`authenticated`; rota que escreve por `service_role`, como
 * esta, fica de fora de propósito).
 *
 * ─── Por que ESPERAR mais é a direção certa ─────────────────────────────────
 *
 * Pelo mesmo motivo que não se repete: o servidor não cancela nada quando o
 * cliente desiste. Abortar uma escrita aos 10s não a impede — só joga fora a
 * RESPOSTA que estava a caminho, trocando um resultado conhecido por uma
 * dúvida. Numa leitura, desistir cedo é bom (a tela não fica presa, e o GET
 * ainda é repetido, então o orçamento dele não mudou); numa escrita, desistir
 * cedo não tem nada a ganhar.
 *
 * 30s não é folga nova: é a mesma parede que a escrita já tinha, entregue como
 * UMA tentativa em vez de três. Chamada que precisa de mais passa `timeoutMs`
 * (o "Testar agente" pede 120s, e segue mandando).
 */
const MUTATION_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 503]);
const MUTATING_METHODS = new Set<HttpMethod>(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * A ORGANIZAÇÃO SUMIU DEBAIXO DE QUEM ESTAVA COM A TELA ABERTA.
 *
 * ─── O defeito, medido pela tela em 2026-09-10 ──────────────────────────────
 *
 * Quem administra revoga o acesso de alguém que está usando o CRM naquele
 * instante. O servidor passa a recusar TODA chamada com `no_active_org`, e a
 * pessoa revogada continua sentada na tela: o menu inteiro no lugar, os dados
 * falhando, e um aviso vermelho em inglês com um uuid cru. A tela de acesso
 * revogado — que existe e funciona — só aparece quando a página é recarregada,
 * porque quem decide é `app/app/layout.tsx`, e ele só roda num carregamento.
 *
 * Entre uma coisa e outra, o produto fica num estado que não é nem "dentro" nem
 * "fora": a pessoa não perdeu o acesso aos olhos dela, perdeu os dados.
 *
 * ─── Por que RECARREGAR, e não mandar direto para /acesso-revogado ──────────
 *
 * Porque `no_active_org` tem mais de uma causa, e o destino certo é diferente
 * em cada uma:
 *
 *   - o vínculo foi revogado          → /acesso-revogado
 *   - a conta nasceu sem organização  → o caminho de recuperação
 *     (provisionamento falhou)
 *
 * Quem sabe distinguir é o servidor, e ele JÁ distingue: a guarda do layout
 * consulta `acessoFoiRevogado` antes de decidir. Repetir essa regra aqui seria
 * uma segunda fonte da mesma verdade — e a que roda no navegador, sem acesso ao
 * banco, seria sempre a pior das duas. Então a tela não decide: ela pergunta de
 * novo.
 *
 * ─── A trava contra o laço ──────────────────────────────────────────────────
 *
 * Se o servidor devolver a mesma tela e a chamada seguinte recusar de novo,
 * recarregar viraria laço infinito — o navegador piscando para sempre, que é
 * pior que o defeito original. A marca em `sessionStorage` sobrevive ao
 * recarregamento (um `let` de módulo não sobreviveria: o módulo nasce de novo) e
 * garante UMA tentativa. Ela é limpa na primeira resposta boa, para que uma
 * revogação futura, na mesma aba, volte a ser tratada.
 */
// Sem o nome do produto dentro: uma imagem serve todas as marcas, e
// `tests/unit/branding.test.ts` varre `lib/` atrás de marca cravada. A chave é
// por origem (o próprio CRM), então não precisa de prefixo para não colidir.
const MARCA_DE_RECARGA = "org-ausente:recarga";

function leuMarca(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(MARCA_DE_RECARGA) !== null;
  } catch {
    // Navegação privada ou armazenamento bloqueado. Sem a marca não há trava
    // contra o laço, então o mais seguro é NÃO recarregar: um erro na tela é
    // ruim, um navegador piscando sem parar é pior.
    return true;
  }
}

/** Lido uma vez, no nascimento do módulo — que é uma vez por carregamento. */
let jaTentouRecarregar = leuMarca();

function limparMarcaDeRecarga(): void {
  if (!jaTentouRecarregar || typeof window === "undefined") return;
  jaTentouRecarregar = false;
  try {
    window.sessionStorage.removeItem(MARCA_DE_RECARGA);
  } catch {
    /* sem armazenamento, a marca já não existia */
  }
}

function pedirDecisaoAoServidor(): void {
  if (typeof window === "undefined" || jaTentouRecarregar) return;
  jaTentouRecarregar = true;
  try {
    window.sessionStorage.setItem(MARCA_DE_RECARGA, "1");
  } catch {
    return; // sem trava, não arrisca o laço
  }
  window.location.reload();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const base = 200 * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100 - 50;
  return Math.max(0, Math.round(base + jitter));
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function synthesizeCode(status: number): string {
  if (status >= 500) return "internal_error";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 400) return "unknown_error";
  return "unknown_error";
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener(
      "abort",
      () => controller.abort(sig.reason),
      { once: true },
    );
  }
  return controller.signal;
}

async function readBodySafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object" &&
    (value as { error: unknown }).error !== null
  );
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const requestId = randomId();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-Id": requestId,
    ...(opts.headers ?? {}),
  };

  if (body !== undefined && body !== null) {
    headers["Content-Type"] ??= "application/json";
  }

  if (MUTATING_METHODS.has(method)) {
    headers["Idempotency-Key"] ??= opts.idempotencyKey ?? randomId();
  }

  const serializedBody =
    body === undefined || body === null ? undefined : JSON.stringify(body);
  const timeoutMs =
    opts.timeoutMs ?? (MUTATING_METHODS.has(method) ? MUTATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeoutController = new AbortController();
    // Motivo explícito, não `abort()` puro: sem ele o navegador sintetiza um
    // `DOMException` cuja MENSAGEM é "signal is aborted without reason" — que
    // chegava ao usuário como erro de runtime, sem dizer que foi um timeout.
    // `name: "TimeoutError"` segue a convenção já em vigor no repo para timeout
    // de fetch: o cliente HTTP da camada de canal usa `AbortSignal.timeout()`,
    // cujo motivo nativo tem exatamente esse nome. Assim quem já checa
    // `err.name === "TimeoutError"` (`lib/ai/credenciais/erro-de-validacao.ts`)
    // também reconhece este.
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException(`A requisição não respondeu em ${timeoutMs}ms.`, "TimeoutError"),
      );
    }, timeoutMs);
    const signal = combineSignals([timeoutController.signal, opts.signal]);

    try {
      const res = await fetch(path, {
        method,
        headers,
        body: serializedBody,
        credentials: "same-origin",
        signal,
      });

      const responseRequestId = res.headers.get("X-Request-Id") ?? requestId;

      if (res.ok) {
        // A instalação voltou a responder: uma revogação futura nesta mesma aba
        // precisa poder recarregar de novo.
        limparMarcaDeRecarga();
        const parsed = (await readBodySafe(res)) as T;
        if (opts.schema) {
          return opts.schema.parse(parsed) as T;
        }
        return parsed;
      }

      // Retry on 429/503
      if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfterSeconds(res.headers.get("Retry-After"));
        const delay = retryAfter !== null ? retryAfter * 1000 : backoffMs(attempt);
        await sleep(delay, opts.signal);
        continue;
      }

      // Non-retry error: parse and throw
      const errBody = await readBodySafe(res);
      if (isApiErrorBody(errBody)) {
        const e = errBody.error;
        // Ver o bloco `MARCA_DE_RECARGA` acima. O `throw` continua acontecendo:
        // o recarregamento não é instantâneo, e quem chamou precisa terminar
        // com erro em vez de ficar pendurado esperando uma resposta que não vem.
        if (res.status === 403 && e.code === "no_active_org") {
          pedirDecisaoAoServidor();
        }
        throw new ApiError(
          res.status,
          e.code ?? synthesizeCode(res.status),
          e.details,
          e.request_id ?? responseRequestId,
          e.message,
        );
      }
      throw new ApiError(
        res.status,
        synthesizeCode(res.status),
        undefined,
        responseRequestId,
        typeof errBody === "string" && errBody.length > 0
          ? errBody
          : `HTTP ${res.status}`,
      );
    } catch (err) {
      // ApiError thrown above for non-retryable: propagate immediately
      if (err instanceof ApiError) {
        throw err;
      }
      // Caller-provided signal aborted: propagate without retry
      if (opts.signal?.aborted) {
        throw err;
      }
      // ⚠️ TIMEOUT NUMA ESCRITA NÃO É "não aconteceu" — é "não sei".
      //
      // O servidor não cancela o trabalho quando o cliente desiste: ele termina
      // e devolve para ninguém. Retentar ali executa a escrita DE NOVO, e o
      // `Idempotency-Key` que este cliente estampa só protege quem o honra —
      // hoje, poucas rotas.
      //
      // Medido (issue #783): "Testar agente" leva ~14,5s de modelo e o timeout
      // padrão é 10s. Um clique virava até TRÊS execuções completas do LLM, as
      // três pagas, nenhuma devolvida à tela — que mostrava só um toast de erro
      // enquanto os créditos iam embora em triplo.
      //
      // Erro de REDE (servidor inalcançável) é indistinguível de timeout aqui,
      // e some no mesmo balde de propósito: na dúvida sobre uma escrita, não
      // repetir é a direção segura. Leitura (GET) segue retentando.
      if (MUTATING_METHODS.has(method)) {
        throw err;
      }
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Exhausted retries on retryable status: throw a synthetic ApiError
  throw lastError ??
    new ApiError(
      503,
      "service_unavailable",
      undefined,
      requestId,
      "Max retries exhausted",
    );
}

export const apiClient = {
  get<T>(path: string, opts?: RequestOpts): Promise<T> {
    return request<T>("GET", path, undefined, opts);
  },
  post<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  patch<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PATCH", path, body, opts);
  },
  put<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PUT", path, body, opts);
  },
  /**
   * `body` é OPCIONAL e novo: a rota de cancelar agendamento exige `{id, reason}`
   * no corpo do DELETE — o motivo do cancelamento é obrigatório de propósito
   * ("cancelado" sem motivo faz alguém ligar para o cliente perguntando o que
   * houve, ou pior, não ligar). Parâmetro opcional no fim mantém os chamadores
   * antigos byte a byte.
   */
  delete<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("DELETE", path, body, opts);
  },
};
