import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { agendaSettingsSchema } from "@/lib/schemas/settings";
import { logger } from "@/lib/logger";
import { IDS_POR_LOTE } from "@/lib/supabase/em-lotes";

export interface CompromissoProtetor {
  id: string;
  contact_id: string | null;
  revision: number;
  starts_at: string;
  ends_at: string;
  status: string;
}
export type ProtecaoAgenda = {
  adiar: boolean;
  motivo:
    | "sem_compromisso"
    | "agendado"
    | "em_atendimento"
    | "presenca_pendente"
    | "presenca_vencida"
    | "leitura_indisponivel";
  appointment_id: string | null;
  reavaliar_em: string | null;
};
export function protecaoDaAgenda(
  compromissos: CompromissoProtetor[],
  settings: unknown,
  agora: Date,
): ProtecaoAgenda {
  const config = agendaSettingsSchema.parse(settings);
  const agoraMs = agora.getTime();
  const vivos = compromissos.filter((a) => a.status === "pending" || a.status === "confirmed");
  let vencido: CompromissoProtetor | undefined;
  for (const a of vivos.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    const inicio = Date.parse(a.starts_at),
      fim = Date.parse(a.ends_at);
    const horizonte = fim + config.unknown_protection_minutes * 60_000;
    if (agoraMs >= horizonte) {
      vencido ??= a;
      continue;
    }
    return {
      adiar: true,
      motivo:
        agoraMs < inicio ? "agendado" : agoraMs < fim ? "em_atendimento" : "presenca_pendente",
      appointment_id: a.id,
      reavaliar_em: new Date(
        Math.min(horizonte, Math.max(agoraMs + 60_000, agoraMs < inicio ? inicio : fim)),
      ).toISOString(),
    };
  }
  return {
    adiar: false,
    motivo: vencido ? "presenca_vencida" : "sem_compromisso",
    appointment_id: vencido?.id ?? null,
    reavaliar_em: null,
  };
}
function indisponivel(agora: Date): ProtecaoAgenda {
  return {
    adiar: true,
    motivo: "leitura_indisponivel",
    appointment_id: null,
    reavaliar_em: new Date(agora.getTime() + 60_000).toISOString(),
  };
}
/** O PostgREST devolve `{ message }` no `error`, não um `Error`. */
function mensagemDoErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  if (typeof erro === "object" && erro !== null && "message" in erro) {
    return String((erro as { message: unknown }).message);
  }
  return String(erro);
}
/** Um aviso por LEITURA, não por contato: com 500 contatos eram 500 linhas iguais. */
function avisoDeIndisponivel(contexto?: Record<string, unknown>): void {
  // Sem contexto, a linha sai exatamente como sempre saiu (uma por contato).
  if (contexto) logger.warn("[agenda] proteção indisponível; cobrança adiada", contexto);
  else logger.warn("[agenda] proteção indisponível; cobrança adiada");
}

/**
 * Quantos contatos entram em cada `.in("contact_id", …)`.
 *
 * O PostgREST devolve a URL INTEIRA no header `Content-Location`, e o Node
 * derruba a resposta acima de 16.384 B (`--max-http-header-size`, o padrão) com
 * `UND_ERR_HEADERS_OVERFLOW`; o gateway na frente do Supabase responde 414
 * acima de 8.192 B de URL. O teto menor é o que manda.
 *
 * Medido com o construtor do próprio supabase-js: um uuid dentro de `in.(…)`
 * pesa 39 B (36 do uuid + 3 do `%2C` que separa) e a parte fixa desta consulta
 * pesa 249 B. O teto por bytes seria (8.192 − 249) / 39 = 203 ids; 100 é o
 * `IDS_POR_LOTE` que `lib/supabase/em-lotes.ts` já usa no resto do repo e deixa
 * a URL em 4.149 B — metade do teto do gateway, um quarto do teto de header.
 */
const CONTATOS_POR_LOTE = IDS_POR_LOTE;

/**
 * Lotes da agenda em voo ao mesmo tempo. São `ceil(contatos / 100)` consultas
 * (50 numa instalação de 5.000): disparar todas de uma vez transforma um
 * soluço do PostgREST na perda da rodada inteira, e uma por contato seria N+1.
 */
const LOTES_EM_PARALELO = 4;

type LeituraDoLote = { ok: true; compromissos: CompromissoProtetor[] } | { ok: false };

/**
 * Todas as páginas de UM lote de contatos.
 *
 * Keyset estável: uma resposta bem-sucedida pode ter sido truncada pelo
 * max_rows do PostgREST. Só página VAZIA prova que a leitura terminou.
 */
async function compromissosDoLote(
  db: SupabaseClient,
  org: string,
  contatos: string[],
): Promise<CompromissoProtetor[]> {
  const appointments: CompromissoProtetor[] = [];
  let after: string | undefined;
  for (;;) {
    let query = db
      .from("calendar_appointments")
      .select("id,contact_id,revision,starts_at,ends_at,status")
      .eq("organization_id", org)
      .in("contact_id", contatos)
      .in("status", ["pending", "confirmed"])
      .order("id", { ascending: true })
      .limit(500);
    if (after) query = query.gt("id", after);
    const page = await query;
    if (page.error) throw page.error;
    if (!page.data?.length) break;
    const last = page.data[page.data.length - 1]!.id;
    if (after && last <= after) throw new Error("agenda_page_did_not_advance");
    appointments.push(...page.data);
    after = last;
  }
  return appointments;
}

export async function protecaoAgendaSupabase(
  db: SupabaseClient,
  org: string,
  contatos: string[],
  agora = new Date(),
): Promise<Map<string, ProtecaoAgenda>> {
  if (!contatos.length) return new Map();
  // Um contato cai em UM lote só — senão o mesmo compromisso entraria duas vezes.
  const unicos = [...new Set(contatos)];
  const lotes: string[][] = [];
  for (let i = 0; i < unicos.length; i += CONTATOS_POR_LOTE) {
    lotes.push(unicos.slice(i, i + CONTATOS_POR_LOTE));
  }
  try {
    // Lotes em paralelo, com teto; o erro de UM lote fica preso nele.
    const leituras: LeituraDoLote[] = Array.from({ length: lotes.length }, () => ({ ok: false }));
    const falhas: unknown[] = [];
    let proximo = 0;
    const trabalhador = async (): Promise<void> => {
      for (;;) {
        const indice = proximo++;
        if (indice >= lotes.length) return;
        try {
          leituras[indice] = { ok: true, compromissos: await compromissosDoLote(db, org, lotes[indice]!) };
        } catch (erro) {
          falhas.push(erro);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LOTES_EM_PARALELO, lotes.length) }, () => trabalhador()),
    );

    const organization = await db.from("organizations").select("settings").eq("id", org).single();
    if (organization.error) throw organization.error;

    const porContato = new Map<string, CompromissoProtetor[]>();
    const semLeitura = new Set<string>();
    for (let i = 0; i < lotes.length; i += 1) {
      const leitura = leituras[i]!;
      if (!leitura.ok) {
        // Lote que falhou NÃO vira "sem compromisso": quem estava nele adia.
        for (const id of lotes[i]!) semLeitura.add(id);
        continue;
      }
      for (const compromisso of leitura.compromissos) {
        if (!compromisso.contact_id) continue;
        const atual = porContato.get(compromisso.contact_id);
        if (atual) atual.push(compromisso);
        else porContato.set(compromisso.contact_id, [compromisso]);
      }
    }
    if (semLeitura.size > 0) {
      avisoDeIndisponivel({
        contatos: unicos.length,
        contatos_adiados: semLeitura.size,
        lotes: lotes.length,
        lotes_com_falha: lotes.length - leituras.filter((l) => l.ok).length,
        error: mensagemDoErro(falhas[0]),
      });
    }
    // A ordem do Map é a da entrada (`contatos`), como antes; dentro de cada
    // contato `protecaoDaAgenda` reordena por `starts_at`.
    return new Map(
      contatos.map((id) => [
        id,
        semLeitura.has(id)
          ? indisponivel(agora)
          : protecaoDaAgenda(
              porContato.get(id) ?? [],
              organization.data.settings?.agenda,
              agora,
            ),
      ]),
    );
  } catch (erro) {
    avisoDeIndisponivel({
      contatos: unicos.length,
      contatos_adiados: unicos.length,
      error: mensagemDoErro(erro),
    });
    return new Map(contatos.map((id) => [id, indisponivel(agora)]));
  }
}
export async function protecaoAgendaPg(
  db: Queryable,
  org: string,
  contact: string,
  agora = new Date(),
): Promise<ProtecaoAgenda> {
  try {
    const [appointments, organization] = await Promise.all([
      db.query<CompromissoProtetor>(
        "select id,contact_id,revision::float8,starts_at::text,ends_at::text,status from calendar_appointments where organization_id=$1 and contact_id=$2 and status in ('pending','confirmed')",
        [org, contact],
      ),
      db.query<{ settings: { agenda?: unknown } }>(
        "select settings from organizations where id=$1",
        [org],
      ),
    ]);
    if (!organization.rows[0]) throw new Error("agenda_org_missing");
    return protecaoDaAgenda(appointments.rows, organization.rows[0].settings?.agenda, agora);
  } catch {
    avisoDeIndisponivel();
    return indisponivel(agora);
  }
}
export class AgendaDeferredError extends Error {
  constructor(public readonly protection: ProtecaoAgenda) {
    super(`agenda:${protection.motivo}`);
    this.name = "AgendaDeferredError";
  }
}
