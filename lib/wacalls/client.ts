/**
 * Cliente REST do WaCalls (chamada de voz WhatsApp) — spec
 * docs/specs/18-spec-voice-calls-wacalls.md §4.1.
 *
 * ═══ ESTE CLIENTE FALA COM O UPSTREAM AUTENTICADO, E ISSO É A DECISÃO ═══
 *
 * A primeira versão desta feature falava com o commit `edeb31f` do WaCalls,
 * cujo README diz, textualmente:
 *
 *   "The API has no authentication — anyone with HTTP access can create
 *    accounts, place calls, and read history. Run it only on a trusted LAN."
 *
 * Aquele build ainda servia a UI React inteira e respondia
 * `Access-Control-Allow-Origin: *`. A defesa era "está só na rede interna do
 * compose" — o que é verdade até o dia em que alguém publica uma porta, e é
 * exatamente por isso que existe `tests/unit/portas-do-compose.test.ts`.
 * Segurança que depende de ninguém errar num arquivo YAML não é segurança.
 *
 * O upstream resolveu isso na origem: o serviço NÃO SOBE sem
 * `WACALLS_ADMIN_USER`/`WACALLS_ADMIN_PASSWORD`, o CORS virou allowlist, entrou
 * rate limit por IP e `WACALLS_API_TOKEN` como Bearer para automação. Por isso
 * o `Authorization` abaixo não é defesa em profundidade opcional: **sem token,
 * a API só é alcançável pelo cookie de login**, e um processo server-to-server
 * não tem cookie. Sem `WACALLS_API_TOKEN` este cliente não funciona.
 *
 * ═══ O QUE MUDOU NO CONTRATO ═══
 *
 * `GET /api/sessions/{sid}/history` deixou de devolver `{rows}` e passa a
 * devolver `{calls, nextCursor}` (keyset). Medido no README do `develop`, não
 * inferido. O restante das rotas manteve caminho e forma.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface WacallsSessionInfo {
  id: string;
  name: string;
  jid: string;
  state: string;
  paired: boolean;
}

export interface WacallsCallRecord {
  sessionId: string;
  callId: string;
  owner: string | null;
  direction: "inbound" | "outbound";
  peer: string;
  startedAt: number;
  status: "starting" | "ringing" | "connected" | "ended";
  endedAt?: number;
  endReason?: string;
}

export class WacallsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        // Bearer em TODA chamada. `/healthz` é a única rota aberta do upstream
        // e não passa por aqui.
        Authorization: `Bearer ${this.apiToken}`,
        ...init?.headers,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`wacalls_${res.status}: ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** POST /api/sessions — cria a conta (não pareia ainda). */
  async createSession(name: string): Promise<{ id: string }> {
    return this.req("/api/sessions", { method: "POST", body: JSON.stringify({ name }) });
  }

  /**
   * POST /api/sessions/{sid}/pair — inicia o pareamento (QR).
   * Não devolve QR síncrono: chega por SSE (`session-qr`). 204 no sucesso.
   */
  async pairSession(sessionId: string): Promise<void> {
    await this.req(`/api/sessions/${encodeURIComponent(sessionId)}/pair`, { method: "POST" });
  }

  /** GET /api/sessions — lista todas as contas conhecidas pelo processo. */
  async listSessions(): Promise<WacallsSessionInfo[]> {
    const out = await this.req<{ sessions: WacallsSessionInfo[] }>("/api/sessions");
    return out.sessions;
  }

  /**
   * DELETE /api/sessions/{sid} — remove a conta do WaCalls.
   *
   * Sozinho não basta para desparear: ver `lib/voice/desparear.ts`, que chama
   * `logoutSession` ANTES desta. O par é o mesmo que
   * `app/api/v1/channel-sessions/[id]/route.ts` faz para o transporte de
   * mensagens.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.req(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  /** POST /api/sessions/{sid}/logout — derruba o vínculo com o WhatsApp. */
  async logoutSession(sessionId: string): Promise<void> {
    await this.req(`/api/sessions/${encodeURIComponent(sessionId)}/logout`, { method: "POST" });
  }

  /**
   * POST /api/sessions/{sid}/calls — inicia chamada outbound.
   * `clientId` vira o dono da chamada (exclusividade) — SEMPRE o user.id da
   * sessão autenticada, nunca escolhido pelo frontend.
   */
  async startCall(sessionId: string, clientId: string, phone: string): Promise<{ callId: string }> {
    const out = await this.req<{ call: { callId: string } }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/calls`,
      {
        method: "POST",
        headers: { "X-Client-Id": clientId },
        // record NUNCA true aqui — gravação fora de escopo desta versão
        // (spec §1.2 item 2, LGPD).
        body: JSON.stringify({ phone }),
      },
    );
    return out.call;
  }

  /** POST /api/sessions/{sid}/calls/{id}/webrtc — relay puro do SDP. */
  async exchangeWebrtc(
    sessionId: string,
    callId: string,
    sdpOffer: string,
  ): Promise<{ sdpAnswer: string }> {
    const out = await this.req<{ sdp_answer: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/webrtc`,
      { method: "POST", body: JSON.stringify({ sdp_offer: sdpOffer }) },
    );
    return { sdpAnswer: out.sdp_answer };
  }

  async acceptCall(sessionId: string, callId: string, clientId: string): Promise<void> {
    await this.req(
      `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/accept`,
      { method: "POST", headers: { "X-Client-Id": clientId } },
    );
  }

  async rejectCall(sessionId: string, callId: string): Promise<void> {
    await this.req(
      `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/reject`,
      { method: "POST" },
    );
  }

  async endCall(sessionId: string, callId: string): Promise<void> {
    await this.req(
      `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * GET /api/sessions/{sid}/history — chamadas encerradas, com cursor.
   *
   * O envelope é `{calls, nextCursor}`. A versão anterior lia `{rows}`, que era
   * o formato do build sem autenticação — ler o campo errado devolve
   * `undefined`, e um histórico vazio tem exatamente a mesma cara de "esta
   * organização não ligou para ninguém".
   */
  async history(
    sessionId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ calls: WacallsCallRecord[]; nextCursor: string | null }> {
    const busca = new URLSearchParams();
    if (opts.limit !== undefined) busca.set("limit", String(opts.limit));
    if (opts.cursor) busca.set("cursor", opts.cursor);
    const qs = busca.toString();
    const out = await this.req<{ calls: WacallsCallRecord[]; nextCursor?: string | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/history${qs ? `?${qs}` : ""}`,
    );
    return { calls: out.calls ?? [], nextCursor: out.nextCursor ?? null };
  }
}

/**
 * `null` quando não configurado — o chamador degrada para "indisponível".
 *
 * As DUAS chaves são exigidas, e o token não é opcional por escolha nossa: o
 * upstream autenticado só aceita Bearer OU cookie de login, e o app não tem
 * cookie. Aceitar `baseUrl` sem token daria um cliente que constrói e devolve
 * 401 em toda chamada — a falha apareceria no primeiro pareamento do cliente,
 * não aqui.
 */
export function getWacallsClient(): WacallsClient | null {
  const url = (env.WACALLS_API_BASE_URL ?? "").trim();
  const token = (env.WACALLS_API_TOKEN ?? "").trim();
  if (!url) {
    logger.debug("wacalls: WACALLS_API_BASE_URL ausente, cliente indisponível");
    return null;
  }
  if (!token) {
    // `warn`, e não `debug`: aqui há intenção declarada (a URL está no .env) e
    // uma configuração pela metade. Silenciar isso é o caso em que a feature
    // "não funciona e ninguém sabe por quê".
    logger.warn("wacalls: WACALLS_API_TOKEN ausente — a API do WaCalls exige Bearer", {});
    return null;
  }
  return new WacallsClient(url, token);
}

export function wacallsFriendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("wacalls_401") || msg.includes("wacalls_403")) {
    return "O serviço de chamada de voz recusou a credencial deste servidor. Confira WACALLS_API_TOKEN.";
  }
  if (msg.includes("operator already on a call")) {
    return "Você já está em outra chamada. Encerre-a antes de iniciar uma nova.";
  }
  if (msg.includes("not paired")) {
    return "O número de chamada de voz ainda não foi pareado. Configure em Configurações › Canais.";
  }
  if (msg.includes("no such session")) {
    return "Sessão de chamada de voz não encontrada.";
  }
  return "Não foi possível completar a chamada. Tente novamente em instantes.";
}
