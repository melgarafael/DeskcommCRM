/**
 * contact-names — copia para a ficha o nome salvo na agenda do celular, num
 * campo que SÓ A EQUIPE vê (`address_book_name`).
 *
 * O webhook só entrega o apelido do perfil. Contato salvo no aparelho, sem
 * apelido, chega na inbox como telefone — medido na caixa de uma instalação
 * real: a lista mostra `+55…` para gente que no celular tem nome. A agenda
 * não viaja na mensagem; ela se pergunta ao canal, como a foto e o telefone
 * do id opaco.
 *
 * O nome da agenda NUNCA vai para `name` nem para `display_name`: é o rótulo
 * que alguém da empresa escreveu no celular, e aqueles dois são o que o
 * `{{nome}}` das automações e das campanhas lê (decisão do mantenedor no PR
 * #2439; o porquê inteiro em `patchDoNome`).
 *
 * Carimba mesmo sem nome. Sem isso os mesmos primeiros N voltariam em toda
 * rodada e quem está no fim da fila nunca seria perguntado. Quem já tem
 * `name` (digitado na ficha ou vindo da planilha) fica de fora: a equipe já o
 * reconhece. Quem já tem nome da agenda também.
 *
 * Fica de fora: empresa parada (a rodada gasta chamada ao canal e escreve na
 * ficha) e contato marcado como pessoal (o que é do dono do número não entra
 * no CRM).
 *
 * Sessão sem o acervo ligado também é consultada: a chave `guardar_historico`
 * pode faltar no `metadata` de uma sessão com o store ligado por fora
 * (ver `OpcoesDeAcervo` no cliente do canal). Sem store, o canal recusa e o
 * contato é só carimbado.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { patchDoNome, REVISITA_NOME_MS } from "@/lib/contacts/nome-da-agenda";
import { logger } from "@/lib/logger";
import { STATUS_OPERANTE, ehOperante, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Contatos por invocação. Cada um pode custar até 3 chamadas ao canal (as duas
 * grafias do nono dígito e o id opaco) de até 2,5 s: 5 × 3 × 2,5 = 37,5 s,
 * dentro dos 60 s que o agendador dá à chamada.
 */
const SCAN_LIMIT = 5;

/** Passado isto, a rodada para e devolve o que fez. Quem não foi visitado não é carimbado. */
const PRAZO_DA_RODADA_MS = 45_000;

interface ContactRow {
  id: string;
  organization_id: string;
  phone_number: string | null;
  wa_lid: string | null;
  wa_identity: string | null;
  name: string | null;
  display_name: string | null;
  address_book_name: string | null;
  /** Status da org embutido — quem decide é `ehOperante`, não uma lista de ids. */
  organizations?: { status?: string | null } | Array<{ status?: string | null }> | null;
}

function lidDe(c: ContactRow): string | null {
  if (c.wa_lid) return c.wa_lid;
  if (c.wa_identity?.startsWith("lid:")) return c.wa_identity.slice("lid:".length);
  return null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - REVISITA_NOME_MS).toISOString();
  const prazo = Date.now() + PRAZO_DA_RODADA_MS;

  const { data: contatos, error: queryError } = await admin
    .from("contacts")
    .select(
      "id, organization_id, phone_number, wa_lid, wa_identity, name, display_name, address_book_name, organizations:organization_id!inner(status)",
    )
    // Empresa parada sai no banco, ANTES do limit — senão ela ocuparia o lote.
    .eq("organizations.status", STATUS_OPERANTE)
    .is("name", null)
    .is("address_book_name", null)
    .eq("kind", "person")
    .eq("is_anonymized", false)
    .eq("is_personal", false)
    .is("is_merged_into", null)
    .or(`name_lookup_at.is.null,name_lookup_at.lt.${cutoff}`)
    .order("name_lookup_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[contact-names] query failed", { detail: queryError.message, requestId });
    return fail("internal_error", queryError.message, 500, { requestId });
  }

  // O filtro do banco decide; `ehOperante` é cinto.
  const rows = ((contatos ?? []) as ContactRow[]).filter((c) => ehOperante(statusDaOrgEmbutida(c.organizations)));
  const preenchidosPorOrg = new Map<string, number>();
  let varridos = 0;
  let preenchidos = 0;
  let semNome = 0;
  let semCanal = 0;

  for (const c of rows) {
    if (Date.now() > prazo) break;
    varridos++;
    const carimbar = async (extra: { address_book_name?: string; display_name?: string }): Promise<boolean> => {
      const { data: afetadas } = await admin
        .from("contacts")
        .update({
          ...extra,
          name_lookup_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .eq("is_anonymized", false)
        .eq("is_personal", false)
        // A ficha pode ter ganhado nome entre a seleção e esta gravação
        // (edição na tela, planilha), ou nome da agenda pelo app WhatsApp
        // Business. Não substituir.
        .is("name", null)
        .is("address_book_name", null)
        .select("id");
      return (afetadas ?? []).length > 0;
    };

    const { data: conversa } = await admin
      .from("conversations")
      .select(`channel_sessions:channel_session_id (${CHANNEL_SESSION_REF_COLUMNS}, status, archived_at)`)
      .eq("organization_id", c.organization_id)
      .eq("contact_id", c.id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const sessaoDaConversa = (conversa as { channel_sessions?: unknown } | null)?.channel_sessions as
      | (ChannelSessionRef & { status: string | null; archived_at: string | null })
      | null
      | undefined;

    const s =
      sessaoDaConversa && !sessaoDaConversa.archived_at && sessaoDaConversa.status === "WORKING"
        ? (sessaoDaConversa as ChannelSessionRef)
        : null;
    const sessionRef = s ? resolveSessionRef(s) : null;
    const adapter = s ? getAdapter((s.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider) : null;
    if (!s || !sessionRef || !adapter?.resolveAddressBookName) {
      await carimbar({});
      semCanal++;
      continue;
    }

    let achado: { agenda: string | null; perfil: string | null } | null = null;
    try {
      achado = await adapter.resolveAddressBookName({
        organizationId: c.organization_id,
        sessionRef,
        phone: c.phone_number,
        lid: lidDe(c),
      });
    } catch (err) {
      logger.warn("[contact-names] lookup falhou", {
        contactId: c.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }

    const extra = achado ? patchDoNome(c, achado) : {};
    const gravou = await carimbar(extra);
    if (Object.keys(extra).length > 0 && gravou) {
      preenchidos++;
      preenchidosPorOrg.set(c.organization_id, (preenchidosPorOrg.get(c.organization_id) ?? 0) + 1);
    } else semNome++;
  }

  // Uma linha por empresa que teve ficha preenchida, na trilha DELA.
  if (preenchidos > 0) {
    for (const [organizationId, n] of preenchidosPorOrg) {
      void audit({
        action: "contact.address_book_name_filled",
        organizationId,
        bypassedRls: true,
        requestId,
        metadata: { preenchidos: n },
      });
    }
  }

  return ok(
    { varridos, preenchidos, sem_nome: semNome, sem_canal: semCanal, interrompida: varridos < rows.length },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
