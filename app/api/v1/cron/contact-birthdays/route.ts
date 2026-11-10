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
 *
 * ═══ N DIAS DE ANTECEDÊNCIA (#3726) ═══
 *
 * O aviso pode sair antes do dia: `trigger_config.dias_antecedencia` (0 = no
 * dia, como sempre foi) desloca o dia ALVO, e a varredura procura o aniversário
 * que cai em `hoje + N`. Duas regras da mesma organização com N diferentes são
 * o caso que manda no desenho (10 dias antes, para a cliente marcar; no dia,
 * para parabenizar) — o evento leva `rule_id` e `lib/automation/engine.ts` o
 * respeita, senão as duas acordariam no mesmo dia.
 *
 * ═══ UMA VEZ POR CONTATO, POR REGRA, POR ANIVERSÁRIO ═══
 *
 * A trava leva o ANO DO ANIVERSÁRIO (`payload.ano_do_aniversario`) junto com o
 * `rule_id`: rodada de hora em hora no mesmo dia não repete o aviso, e a virada
 * do ano — que é o dia comum de quem nasceu em janeiro com N>0 — reabre o
 * disparo do aniversário seguinte, porque o ano celebrado mudou. Evento anterior
 * a esta versão (sem `rule_id`) continua bloqueando pela janela de 26h: mudar a
 * chave da trava não pode parabenizar de novo quem já recebeu hoje.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { ok, fail } from "@/lib/api/wrappers";
import {
  aniversarioDoAviso,
  anoDoAniversario,
  aniversariosAlvo,
  configDoAniversario,
} from "@/lib/automation/aniversario-do-contato";
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
  return diasDeAniversarioEm(agora, fuso, 0);
}

/**
 * Os mesmos dias, para uma regra de N dias de antecedência (#3726).
 *
 * `diasAntes = 0` devolve exatamente o que `diasDeAniversarioAgora` devolvia
 * antes desta feature — o caminho de quem nunca configurou o campo não mudou.
 */
export function diasDeAniversarioEm(agora: Date, fuso: string, diasAntes: number): number[] {
  const { ano, mes, dia, hora } = partesNoFuso(agora, fuso);
  if (hora !== HORA_DE_PARABENIZAR) return [];

  const dois = (n: number) => String(n).padStart(2, "0");
  return aniversariosAlvo(`${ano}-${dois(mes)}-${dois(dia)}`, diasAntes);
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
    .select("id, organization_id, trigger_config")
    .eq("trigger_event", "contact.birthday")
    .eq("is_active", true);

  if (erroRegras) {
    logger.error("[contact-birthdays] consulta de regras falhou", {
      error: erroRegras.message,
      requestId,
    });
    return fail("internal_error", "Falha ao buscar regras.", 500, { requestId });
  }

  const todasAsRegras = regras ?? [];
  if (todasAsRegras.length === 0) {
    return ok(
      { organizacoes: 0, regras: 0, examinados: 0, emitidos: 0, pulados: {} },
      { requestId },
    );
  }

  const orgsComRegra = [...new Set(todasAsRegras.map((r) => r.organization_id as string))];
  const { data: organizacoes } = await admin
    .from("organizations")
    .select("id, timezone")
    .in("id", orgsComRegra.slice(0, TAMANHO_DO_LOTE));

  let emitidos = 0;
  let examinados = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string, quantos = 1) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + quantos;
  };

  for (const organizacao of organizacoes ?? []) {
    const org = organizacao.id as string;
    const fuso = (organizacao.timezone as string | null) ?? FUSO_PADRAO;

    let parede: ReturnType<typeof partesNoFuso>;
    try {
      parede = partesNoFuso(agora, fuso);
    } catch {
      // `partesNoFuso` lança em fuso inexistente, de propósito. Uma organização
      // com o campo digitado errado não pode derrubar a varredura das outras.
      pular("fuso_invalido");
      continue;
    }
    // Fora da hora marcada a organização inteira fica de fora — é o que faz a
    // varredura horária agir uma vez por dia em cada fuso.
    if (parede.hora !== HORA_DE_PARABENIZAR) continue;

    const dois = (n: number) => String(n).padStart(2, "0");
    const dataLocal = `${parede.ano}-${dois(parede.mes)}-${dois(parede.dia)}`;
    // A rodada pode alcançar a hora marcada DUAS vezes no dia em que o fuso
    // recua (fim do horário de verão). A janela é de 26 horas, e não de 24,
    // porque com 24 exatas o segundo encontro cairia fora por minutos.
    const desde = new Date(agora.getTime() - 26 * 3_600_000).toISOString();

    for (const regra of todasAsRegras) {
      if (regra.organization_id !== org) continue;
      const regraId = regra.id as string;

      const config = configDoAniversario(regra.trigger_config);
      if (!config) {
        // Linha torta (preenchida à mão, ou de antes de a tela existir) não
        // casa com nada, e não impede as irmãs de rodar.
        pular("config_invalida");
        continue;
      }

      const dias = aniversariosAlvo(dataLocal, config.dias_antecedencia);
      const dataDoAniversario = aniversarioDoAviso(dataLocal, config.dias_antecedencia);
      const anoDoAviso = anoDoAniversario(dataDoAniversario);
      if (dias.length === 0 || anoDoAviso === null) {
        pular("config_invalida");
        continue;
      }

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
          rule_id: regraId,
          error: error.message,
          requestId,
        });
        pular("consulta_falhou");
        continue;
      }
      if (!contatos?.length) continue;
      examinados += contatos.length;

      const ids = contatos.map((c) => c.id as string);
      const jaEmitidos = new Set<string>();

      // A trava ANUAL: mesmo contato, MESMA REGRA, MESMO aniversário. O ano é o
      // do aniversário celebrado (não o do disparo), então o aviso de 10 dias
      // que sai em 26/12 pertence ao aniversário do ano seguinte — e não é
      // reaberto por ele mesmo na rodada seguinte, nem na virada do ano.
      for (let i = 0; i < ids.length; i += TAMANHO_DO_LOTE) {
        const lote = ids.slice(i, i + TAMANHO_DO_LOTE);
        const { data: anteriores } = await admin
          .from("event_log")
          .select("entity_id")
          .eq("organization_id", org)
          .eq("event_type", "contact.birthday")
          .eq("payload->>rule_id", regraId)
          .eq("payload->>ano_do_aniversario", String(anoDoAviso))
          .in("entity_id", lote);
        for (const anterior of anteriores ?? []) jaEmitidos.add(anterior.entity_id as string);
      }

      // A trava ANTIGA, para quem já foi parabenizado hoje por uma versão que
      // não carimbava `rule_id`: sem isto, o deploy do meio-dia parabenizaria
      // de novo quem recebeu às 9h. Só linhas SEM `rule_id` entram aqui — as
      // desta versão já estão cobertas pela trava anual acima.
      for (let i = 0; i < ids.length; i += TAMANHO_DO_LOTE) {
        const lote = ids.slice(i, i + TAMANHO_DO_LOTE);
        const { data: recentes } = await admin
          .from("event_log")
          .select("entity_id, payload")
          .eq("organization_id", org)
          .eq("event_type", "contact.birthday")
          .in("entity_id", lote)
          .gte("created_at", desde);
        for (const recente of recentes ?? []) {
          // `Json` → objeto: o payload do `event_log` não tem esquema, e a
          // asserção dupla é o que o tipo gerado exige para ler uma chave.
          const carregado = (recente.payload ?? null) as unknown as Record<string, unknown> | null;
          if (carregado && typeof carregado.rule_id === "string") continue;
          jaEmitidos.add(recente.entity_id as string);
        }
      }

      for (const contato of contatos) {
        const id = contato.id as string;
        if (jaEmitidos.has(id)) {
          pular("ja_emitido");
          continue;
        }
        const { error: erroEvento } = await admin.rpc("emit_event" as never, {
          // Literal de propósito: `tests/unit/aniversario-oferece-condicao-que-
          // funciona.test.ts` lê o emissor DO FONTE e o compara com
          // `ENTIDADE_ESPERADA_POR_GATILHO`; uma constante aqui deixaria a sonda
          // sem o que ler.
          p_event_type: "contact.birthday",
          p_entity_kind: "contact",
          p_entity_id: id,
          // A data LOCAL vai no payload porque é o que a organização enxerga:
          // quem for depurar "por que saiu ontem" precisa do dia dela, não do
          // UTC da linha. `rule_id` dirige o evento a UMA regra (#3726) e
          // `ano_do_aniversario` é a chave da trava anual.
          p_payload: {
            rule_id: regraId,
            dias_antecedencia: config.dias_antecedencia,
            data_do_aniversario: dataDoAniversario,
            ano_do_aniversario: anoDoAviso,
            local_date: dataLocal,
          },
          p_metadata: { actor_kind: "system", source: "cron/contact-birthdays" },
          p_organization_id: org,
        });
        if (erroEvento) {
          logger.error("[contact-birthdays] emit_event falhou", {
            organization_id: org,
            rule_id: regraId,
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
    {
      organizacoes: (organizacoes ?? []).length,
      regras: todasAsRegras.length,
      examinados,
      emitidos,
      pulados,
    },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
