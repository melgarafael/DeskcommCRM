/**
 * O ANIVERSÁRIO DO CONTATO — a data que estava guardada e não acionava nada.
 *
 * `contacts.birthdate` existe desde cedo, aparece na ficha e nunca saiu por
 * lugar nenhum: quem quisesse parabenizar teria de olhar contato por contato.
 * Este cron transforma a data em acontecimento (`contact.birthday` no
 * `event_log`), e quem decide o que fazer com ele é a automação que a
 * organização configurar — a ação de mandar WhatsApp já existe no motor.
 *
 * ═══ POR QUE UM EVENTO, E NÃO UM ENVIO DAQUI ═══
 *
 * Mandar a mensagem direto daqui seria mais curto e erraria o desenho: o texto,
 * a condição ("só quem está na etapa X"), o registro do run e a auditoria já
 * vivem no motor de regras. Um segundo caminho de envio teria de reimplementar
 * os quatro, e divergiria no primeiro conserto.
 *
 * ═══ SÓ AS ORGANIZAÇÕES QUE PEDIRAM ═══
 *
 * A varredura começa pelas REGRAS, não pelos contatos. Sem isso, toda
 * instalação emitiria um evento por aniversariante todo dia para ninguém ouvir
 * — evento sem consumer é o anti-pattern 3, e aqui ele custaria linha no
 * `event_log` de quem não usa a automação.
 *
 * ═══ A HORA É LOCAL, E ISSO NÃO É DETALHE ═══
 *
 * "Hoje" depende do fuso da organização. Um cron que decidisse pelo UTC
 * parabenizaria no dia errado metade do mundo, e de madrugada boa parte do
 * resto. A varredura roda de hora em hora e só age na organização cujo relógio
 * de parede marca `HORA_DE_PARABENIZAR` — o que resolve o dia e a hora decente
 * com a mesma regra.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** O relógio de parede da organização em que o parabéns sai. */
export const HORA_DE_PARABENIZAR = 9;

/** Fuso de quem não declarou o seu — o mesmo padrão do resto do produto. */
const FUSO_PADRAO = "America/Sao_Paulo";

/** Quantos contatos uma organização pode parabenizar por rodada. */
const TETO_POR_ORGANIZACAO = 200;

/** O PostgREST monta a lista do `in` dentro da URL, e URL tem fim. */
const TAMANHO_DO_LOTE = 100;

/**
 * Quais dias de aniversário esta organização parabeniza AGORA.
 *
 * Devolve vazio fora da hora marcada — é o que faz a varredura horária agir uma
 * vez por dia em cada fuso.
 *
 * ⚠️ **29 DE FEVEREIRO.** Quem nasceu em 29/02 não tem aniversário em três de
 * cada quatro anos. Deixar assim seria uma pessoa parabenizada uma vez a cada
 * quatro — o tipo de falha que ninguém reporta e todo mundo nota. Em ano não
 * bissexto, o dia 28 responde também pelo 29.
 *
 * Pura e exportada porque decide se alguém recebe mensagem, e isso precisa ser
 * exercitável sem banco e sem esperar um 29 de fevereiro.
 */
export function diasDeAniversarioAgora(agora: Date, fuso: string): number[] {
  const { ano, mes, dia, hora } = partesNoFuso(agora, fuso);
  if (hora !== HORA_DE_PARABENIZAR) return [];

  const hoje = mes * 100 + dia;
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
  return hoje === 228 && !bissexto ? [228, 229] : [hoje];
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const { data: regras, error: erroRegras } = await admin
    .from("automation_rules")
    .select("organization_id")
    .eq("trigger_event", "contact.birthday")
    .eq("is_active", true);

  if (erroRegras) {
    logger.error("[contact-birthdays] consulta de regras falhou", {
      error: erroRegras.message,
      requestId,
    });
    return fail("internal_error", "Falha ao buscar regras.", 500, { requestId });
  }

  const orgsComRegra = [...new Set((regras ?? []).map((r) => r.organization_id as string))];
  if (orgsComRegra.length === 0) {
    return ok({ organizacoes: 0, examinados: 0, emitidos: 0, pulados: {} }, { requestId });
  }

  const { data: organizacoes } = await admin
    .from("organizations")
    .select("id, timezone")
    .in("id", orgsComRegra.slice(0, TAMANHO_DO_LOTE));

  let emitidos = 0;
  let examinados = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + 1;
  };

  for (const organizacao of organizacoes ?? []) {
    const org = organizacao.id as string;
    const fuso = (organizacao.timezone as string | null) ?? FUSO_PADRAO;

    let dias: number[];
    let parede: ReturnType<typeof partesNoFuso>;
    try {
      parede = partesNoFuso(agora, fuso);
      dias = diasDeAniversarioAgora(agora, fuso);
    } catch {
      // `partesNoFuso` lança em fuso inexistente, de propósito. Uma organização
      // com o campo digitado errado não pode derrubar a varredura das outras.
      pular("fuso_invalido");
      continue;
    }
    if (dias.length === 0) continue;

    const { data: contatos, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", org)
      .in("birthday_md", dias)
      .eq("is_blocked", false)
      .not("phone_number", "is", null)
      .limit(TETO_POR_ORGANIZACAO);

    if (error) {
      logger.error("[contact-birthdays] consulta de contatos falhou", {
        organization_id: org,
        error: error.message,
        requestId,
      });
      pular("consulta_falhou");
      continue;
    }
    if (!contatos?.length) continue;
    examinados += contatos.length;

    // Quem já foi parabenizado nesta volta do dia não é parabenizado de novo.
    //
    // A janela é de 26 horas, e não de 24, porque a hora marcada pode ser
    // alcançada DUAS vezes no dia em que o fuso recua (fim do horário de verão).
    // Com 24 exatas, o segundo encontro cairia fora da janela por minutos e a
    // pessoa receberia dois parabéns.
    const desde = new Date(agora.getTime() - 26 * 3_600_000).toISOString();
    const jaEmitidos = new Set<string>();
    for (let i = 0; i < contatos.length; i += TAMANHO_DO_LOTE) {
      const lote = contatos.slice(i, i + TAMANHO_DO_LOTE).map((c) => c.id as string);
      const { data: anteriores } = await admin
        .from("event_log")
        .select("entity_id")
        .eq("organization_id", org)
        .eq("event_type", "contact.birthday")
        .in("entity_id", lote)
        .gte("created_at", desde);
      for (const anterior of anteriores ?? []) jaEmitidos.add(anterior.entity_id as string);
    }

    const dataLocal =
      `${parede.ano}-${String(parede.mes).padStart(2, "0")}-${String(parede.dia).padStart(2, "0")}`;

    for (const contato of contatos) {
      const id = contato.id as string;
      if (jaEmitidos.has(id)) {
        pular("ja_emitido_hoje");
        continue;
      }
      const { error: erroEvento } = await admin.rpc("emit_event" as never, {
        p_event_type: "contact.birthday",
        p_entity_kind: "contact",
        p_entity_id: id,
        // A data LOCAL vai no payload porque é o que a organização enxerga: quem
        // for depurar "por que saiu ontem" precisa do dia dela, não do UTC da
        // linha.
        p_payload: { local_date: dataLocal },
        p_metadata: { actor_kind: "system", source: "cron/contact-birthdays" },
        p_organization_id: org,
      });
      if (erroEvento) {
        logger.error("[contact-birthdays] emit_event falhou", {
          organization_id: org,
          contact_id: id,
          error: erroEvento.message,
          requestId,
        });
        pular("emissao_falhou");
        continue;
      }
      emitidos += 1;
    }
  }

  // Rodada que não emitiu nada NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (emitidos > 0) {
    await audit({
      action: "contact.aniversario_emitido",
      resourceType: "contact",
      metadata: { emitidos, examinados, pulados },
      requestId,
    });
  }

  return ok(
    { organizacoes: (organizacoes ?? []).length, examinados, emitidos, pulados },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
