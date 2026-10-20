/**
 * A transmissão pelo parceiro — os broadcasts dele (`/v1/broadcasts`).
 *
 * Fonte: a especificação publicada (https://docs.zernio.com/api/openapi, versão
 * 1.290.1, lida em 16/10/2026) e a prova real do mesmo dia (2 destinatários,
 * entregues em 1 a 3 s). O caminho é sempre o mesmo: criar o rascunho com o
 * modelo → pôr os telefones → mandar → ler o relatório por destinatário.
 *
 * Três coisas que a documentação não diz e a prova mediu:
 *
 *  - O `variableMapping` não é aplicado: a variável chegou ao celular como
 *    "{{1}}". O valor que sai é o TEXTO de cada parâmetro de `components`. Por
 *    isso vai o valor já escrito nos dois lugares — se um dia o mapeamento
 *    passar a valer, ele diz a mesma coisa.
 *  - O nome que o parceiro guarda de cada contato é o número (`contactName`),
 *    inclusive de quem o CRM conhece pelo nome. Nome por destinatário não
 *    existe aqui — e é por isso que a campanha só transmite texto fixo.
 *  - O `profileId` obrigatório não está na conexão: vem da conta, em
 *    `GET /v1/accounts` (um objeto `{_id, name}`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ErroDaTransmissao,
  digitosDoTelefone,
  type DestinatarioDaTransmissao,
  type EscopoDaTransmissao,
  type EstadoDaTransmissao,
  type OpsDeTransmissao,
} from "../transmissao-tipos";
import { resolveZernioCreds, type ZernioCredentials } from "./credentials";

/** A especificação aceita até 20.000 telefones por chamada; o lote fica abaixo. */
const TELEFONES_POR_CHAMADA = 5_000;

const ESTADOS: ReadonlySet<string> = new Set(["draft", "scheduled", "sending", "completed", "failed", "cancelled"]);
const STATUS_DO_DESTINATARIO: ReadonlySet<string> = new Set(["pending", "sent", "delivered", "read", "failed"]);

type Bruto = Record<string, unknown>;

function texto(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function estadoDe(v: unknown): EstadoDaTransmissao {
  const s = texto(v);
  if (s && ESTADOS.has(s)) return s as EstadoDaTransmissao;
  throw new ErroDaTransmissao(502, "estado_desconhecido", `estado de transmissão desconhecido: ${s ?? "vazio"}`);
}

export function destinatarioDoParceiro(r: Bruto): DestinatarioDaTransmissao | null {
  const telefone = digitosDoTelefone(texto(r.platformIdentifier));
  const status = texto(r.status);
  if (!telefone || !status || !STATUS_DO_DESTINATARIO.has(status)) return null;
  return {
    telefone,
    status: status as DestinatarioDaTransmissao["status"],
    idDaMensagem: texto(r.messageId),
    codigoDoErro: texto(r.errorCode),
    erro: texto(r.errorExplanation) ?? texto(r.error),
    enviadoEm: texto(r.sentAt),
    entregueEm: texto(r.deliveredAt),
    lidoEm: texto(r.readAt),
  };
}

export async function transmissaoDoParceiro(
  admin: SupabaseClient,
  escopo: EscopoDaTransmissao,
): Promise<OpsDeTransmissao | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("zernio_account_id")
    .eq("organization_id", escopo.organizationId)
    .eq("id", escopo.channelSessionId)
    .maybeSingle();
  const accountId = (data as { zernio_account_id?: string | null } | null)?.zernio_account_id ?? null;
  if (!accountId) return null;

  let credenciais: ZernioCredentials | null = null;
  /** Lido uma vez por rodada: a mesma conta, a mesma resposta. */
  let perfilDaConta: string | null = null;
  async function creds(): Promise<ZernioCredentials> {
    credenciais ??= await resolveZernioCreds(admin, { organizationId: escopo.organizationId, accountId: accountId! });
    if (!credenciais) throw new ErroDaTransmissao(401, "sem_credencial", "a conexão não tem credencial do provedor");
    return credenciais;
  }

  async function chamar<T extends Bruto>(
    metodo: "GET" | "POST",
    caminho: string,
    corpo?: unknown,
    consulta?: Record<string, string>,
  ): Promise<T> {
    const c = await creds();
    const url = new URL(`${c.baseUrl}${caminho}`);
    for (const [k, v] of Object.entries(consulta ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
    });
    const json = (await res.json().catch(() => null)) as (Bruto & { error?: unknown; code?: unknown }) | null;
    if (!res.ok || json?.success === false) {
      const codigo = texto(json?.code) ?? `http_${res.status}`;
      const detalhe = texto(json?.error) ?? res.statusText;
      throw new ErroDaTransmissao(res.status, codigo, `${res.status} ${detalhe}`.trim());
    }
    return (json ?? {}) as T;
  }

  async function perfil(): Promise<string> {
    if (perfilDaConta) return perfilDaConta;
    const j = await chamar<{ accounts?: Bruto[] }>("GET", "/v1/accounts");
    const conta = (j.accounts ?? []).find((a) => a._id === accountId || a.id === accountId);
    const p = conta?.profileId;
    const id = typeof p === "string" ? p : texto((p as Bruto | null | undefined)?._id) ?? texto((p as Bruto | null | undefined)?.id);
    if (!id) throw new ErroDaTransmissao(404, "sem_perfil", "a conta do provedor não tem perfil para a transmissão");
    perfilDaConta = id;
    return id;
  }

  return {
    async criar({ nome, modelo }) {
      const template: Bruto = { name: modelo.name, language: modelo.language };
      if (modelo.components.length > 0) template.components = modelo.components;
      if (modelo.valoresDoCorpo.length > 0) {
        template.variableMapping = Object.fromEntries(
          modelo.valoresDoCorpo.map((valor, i) => [String(i + 1), { field: "custom", customValue: valor }]),
        );
      }
      const j = await chamar<{ broadcast?: Bruto }>("POST", "/v1/broadcasts", {
        profileId: await perfil(),
        accountId,
        platform: "whatsapp",
        name: nome.slice(0, 200),
        template,
      });
      const id = texto(j.broadcast?.id);
      if (!id) throw new ErroDaTransmissao(502, "sem_id", "o provedor não devolveu o id da transmissão");
      return { id };
    },

    async adicionar(id, telefones) {
      let adicionados = 0;
      let pulados = 0;
      for (let i = 0; i < telefones.length; i += TELEFONES_POR_CHAMADA) {
        const lote = telefones.slice(i, i + TELEFONES_POR_CHAMADA).map((t) => `+${digitosDoTelefone(t)}`);
        const j = await chamar<{ added?: unknown; skipped?: unknown }>(
          "POST",
          `/v1/broadcasts/${encodeURIComponent(id)}/recipients`,
          { phones: lote },
        );
        adicionados += Number(j.added ?? 0) || 0;
        pulados += Number(j.skipped ?? 0) || 0;
      }
      return { adicionados, pulados };
    },

    async enviar(id) {
      const j = await chamar<{ status?: unknown }>("POST", `/v1/broadcasts/${encodeURIComponent(id)}/send`);
      return { estado: estadoDe(j.status) };
    },

    async ler(id) {
      const j = await chamar<{ broadcast?: Bruto; status?: unknown }>("GET", `/v1/broadcasts/${encodeURIComponent(id)}`);
      return { estado: estadoDe(j.broadcast?.status ?? j.status) };
    },

    async destinatarios(id, { pular, quantos }) {
      const j = await chamar<{ recipients?: Bruto[]; pagination?: Bruto }>(
        "GET",
        `/v1/broadcasts/${encodeURIComponent(id)}/recipients`,
        undefined,
        { limit: String(quantos), skip: String(pular) },
      );
      const brutos = j.recipients ?? [];
      return {
        itens: brutos.map(destinatarioDoParceiro).filter((d): d is DestinatarioDaTransmissao => d !== null),
        temMais: j.pagination?.hasMore === true && brutos.length > 0,
        lidos: brutos.length,
      };
    },

    async cancelar(id) {
      try {
        await chamar("POST", `/v1/broadcasts/${encodeURIComponent(id)}/cancel`);
      } catch (err) {
        // 400 = "não dá para cancelar neste estado": já terminou, ou nem saiu do
        // rascunho. Nos dois casos não há o que parar, e não é falha de quem cancela.
        if (err instanceof ErroDaTransmissao && err.status === 400) return;
        throw err;
      }
    },
  };
}
