/**
 * TIPOS DE AGENDAMENTO — alterar e desativar, a regra fora do route handler.
 *
 * ─── Por que este módulo existe ──────────────────────────────────────────────
 *
 * A regra de `PATCH`/`DELETE /api/v1/agenda/tipos` nasceu inteira dentro de
 * `app/api/v1/agenda/tipos/route.ts`. Quem não é a rota — o servidor MCP, uma
 * automação, qualquer consumidor dentro do processo — precisava do MESMO
 * comportamento para alterar ou desativar um tipo e só tinha dois caminhos
 * ruins: chamar a própria API por HTTP, ou copiar a regra (e a cópia envelhece
 * calada). Ver a issue #4688, e o desenho irmão em `./consulta.ts`
 * (`listaTiposDeAtendimento`), que o `GET` já usa.
 *
 * O `POST` continua na rota: ele repete a conferência do canal e do modelo, e
 * agora usa os mesmos ajudantes exportados daqui — mas o fluxo de criação fica
 * fora deste pedido para o PR continuar pequeno.
 *
 * ─── Desativar, nunca apagar ─────────────────────────────────────────────────
 *
 * `calendar_appointments.event_type_id` aponta para `calendar_event_types`.
 * Apagar o tipo levaria junto a história — que consulta foi feita, de que tipo,
 * quanto durava. O `DELETE` grava `is_active = false`: some da tela de marcar e
 * continua respondendo pelo passado. É o mesmo raciocínio do anti-pattern 7 da
 * doutrina (cascade fantasma).
 *
 * ─── `is_active` está fora do PATCH DE PROPÓSITO ─────────────────────────────
 *
 * Aceitá-lo em `camposDoTipo` deixaria o mesmo pedido que muda a duração
 * desligar o tipo, e a trilha registraria a religada como
 * `agenda.tipo_alterado { campos: ["is_active"] }` — indistinguível de uma
 * alteração de campo qualquer. A volta mora AO LADO, em
 * `POST /api/v1/agenda/tipos/reativar`.
 *
 * ⚠️ Essa exclusão é silenciosa e já custou: Zod DESCARTA chave desconhecida sem
 * dizer nada, então o botão "Reativar" da tela mandou `is_active` para cá
 * durante toda a vida dele e recebeu 422 "Nenhum campo para alterar." — uma
 * recusa que não nomeia o que foi descartado. Quem vigia a travessia hoje é
 * `tests/unit/agenda-reativar-tipo.test.ts`.
 *
 * ─── A borda fica na rota ────────────────────────────────────────────────────
 *
 * `requireSupportWrite`, `resolveAuthDual`, `tetoDeEscritaDoToken`, o JSON, o
 * Zod e a montagem de `ok()`/`fail()` com o `requestId`. Estas funções recebem o
 * cliente de banco que a rota já usa, o `organizationId` resolvido e a entrada
 * JÁ validada; devolvem resultado discriminado, sem `Response` e sem
 * `NextRequest`.
 *
 * `ator.t` é o tradutor da borda (o mesmo `traduzir(texto, authz.idioma)`).
 * Entra como dependência porque as mensagens daqui são literais de dicionário e
 * o idioma é resolvido na rota; sem ele o padrão é identidade — pt-BR, que é o
 * texto escrito abaixo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { TETO_DE_LEMBRETES_EXTRAS } from "@/lib/agenda/lembretes";
import { variaveisQueOLembretePreenche } from "@/lib/agenda/lembrete-por-modelo";
import { transportaMensagem } from "@/lib/channels/capabilities";

/** As dez do CHECK da tabela. Fora daqui o Postgres recusa — melhor recusar antes. */
const CATEGORIAS = [
  "consulta",
  "procedimento",
  "retorno",
  "visita",
  "vistoria",
  "reuniao",
  "call",
  "orcamento",
  "demonstracao",
  "outro",
] as const;

const LOCAIS = ["in_person", "phone", "whatsapp", "video_link", "google_meet"] as const;

/**
 * Os limites são os MESMOS do CHECK do banco, e isso é deliberado.
 *
 * Zod aqui não substitui a constraint: ela é a verdade e continua valendo para
 * quem escrever por SQL. O que a validação faz é transformar um 500 de constraint
 * — que aparece como "erro interno" para quem está usando — numa recusa 422 que
 * diz o que está fora.
 */
export const camposDoTipo = {
  name: z.string().trim().min(2).max(80),
  category: z.enum(CATEGORIAS),
  duration_minutes: z.number().int().min(5).max(1440),
  location_kind: z.enum(LOCAIS),
  description: z.string().trim().max(500).nullish(),
  location_details: z.string().trim().max(300).nullish(),
  default_owner_user_id: z.string().uuid().nullish(),
  requires_confirmation: z.boolean().optional(),
  buffer_before_minutes: z.number().int().min(0).max(720).optional(),
  buffer_after_minutes: z.number().int().min(0).max(720).optional(),
  minimum_notice_minutes: z.number().int().min(0).max(43_200).optional(),
  booking_window_days: z.number().int().min(1).max(365).optional(),
  /**
   * O LEMBRETE — os dois campos que o cron `agenda-reminder` lê e que ninguém
   * conseguia escrever.
   *
   * A 0177 criou as colunas, a 0194 as pôs em `default false` deixando escrito
   * que ligar por padrão "fica com o dono do produto NO DIA em que o disparador
   * nascer", e o `99c33257` fez o disparador nascer. Faltava a outra metade do
   * par: `reminder_enabled` não estava em schema nenhum aqui nem na tela, então
   * a rodada do cron devolvia zero linhas em TODA instalação — capacidade que
   * existe e não tem como ser usada (invariante 6 do Sistema Vivo).
   *
   * **Continua nascendo desligado.** Não há `.default(true)`: quem não manda o
   * campo não liga nada, e o default da coluna segue sendo `false`. Mandar
   * mensagem para o telefone de um cliente é irreversível.
   */
  reminder_enabled: z.boolean().optional(),
  /**
   * O BLOCO DO NEGÓCIO na descrição do evento do Google (#4006, doc 272 = B).
   *
   * Nasce desligado (default da coluna, migration 9209) e não tem `.default()`
   * aqui: no Google todo convidado lê a descrição, inclusive o cliente com
   * e-mail na ficha, e atualizar o sistema não pode mandar o nome, o telefone e
   * a etapa do funil para fora sem alguém decidir.
   */
  levar_dados_do_negocio: z.boolean().optional(),
  reminder_channel_session_id: z.string().uuid().nullish(),
  /**
   * O modelo aprovado que sai quando a janela de 24 h do cliente fechou
   * (`lib/agenda/lembrete-por-modelo.ts`). Nulo = como antes: fora da janela o
   * lembrete não sai e a equipe recebe o aviso. Conferido em
   * `recusaDoModeloDoLembrete` antes de gravar.
   */
  reminder_meta_template_id: z.string().uuid().nullish(),
  /**
   * O PREÇO PADRÃO do serviço, em centavos.
   *
   * Opcional e sem default: nem todo negócio tem preço fixo, e obrigar um número
   * faria quem cobra por hora inventar um. Vazio significa "digite na hora".
   *
   * É semente do item da comanda, nunca o preço dele — o item congela o seu.
   */
  default_price_cents: z.number().int().min(0).max(100_000_000).nullish(),
  /**
   * ⚠️ ESTA FAIXA É MAIS ESTREITA QUE O CHECK DO BANCO, E ISSO CONTRARIA O
   * PARÁGRAFO ACIMA DE PROPÓSITO.
   *
   * A coluna aceita `between 0 and 43200`, e os campos vizinhos copiam o CHECK
   * porque lá a borda do banco É a borda do sentido: `buffer_after_minutes = 0`
   * é "sem folga", uma configuração legítima. Aqui as duas bordas do CHECK
   * produzem lembrete que não lembra:
   *
   * - **0 min** nunca sai. `estaNaHora` recusa `comeca <= agora`, então um
   *   lembrete marcado para o próprio instante do compromisso é descartado em
   *   toda rodada até a linha sair da varredura. O piso é 15 min porque o cron
   *   roda a cada 5: abaixo de três ciclos, uma rodada atrasada come a
   *   antecedência inteira e o aviso chega depois de a pessoa já ter saído.
   * - **43200 min (30 dias)** não é lembrete, é convite. O teto é 10080 (7
   *   dias), que cobre o "semana que vem" de clínica e imobiliária.
   *
   * A borda continua sendo do banco para quem escreve por SQL — aqui a recusa é
   * só antes, com nome. Uma linha semeada fora desta faixa (só por SQL direto;
   * o default da 0177 é 1440) segue valendo no banco e o cron a respeita: o que
   * ela perde é poder ser reenviada por esta rota sem entrar na faixa.
   */
  reminder_minutes_before: z
    .number()
    .int()
    .min(15, { message: "O lembrete precisa sair pelo menos 15 minutos antes do compromisso." })
    .max(10_080, { message: "O lembrete não pode sair mais de 7 dias (10080 minutos) antes." })
    .optional(),
  /**
   * Os degraus ADICIONAIS — o "e de novo três horas antes" que faltava.
   *
   * `reminder_minutes_before` continua sendo o degrau principal; estes somam a
   * ele. Vazio é o comportamento anterior, um lembrete só, e por isso o campo
   * não tem `.default()`: quem não manda não ganha aviso nenhum a mais.
   *
   * O teto é o mesmo do CHECK (`fn_degraus_de_lembrete_validos`): guarda contra
   * laço de formulário, não contra a operação. Quem decide quantos avisos o
   * cliente recebe é quem edita o tipo.
   */
  reminder_extra_offsets_minutes: z
    .array(
      z
        .number()
        .int()
        .min(15, { message: "O lembrete precisa sair pelo menos 15 minutos antes do compromisso." })
        .max(10_080, { message: "O lembrete não pode sair mais de 7 dias (10080 minutos) antes." }),
    )
    .max(TETO_DE_LEMBRETES_EXTRAS, {
      message: `No máximo ${TETO_DE_LEMBRETES_EXTRAS} lembretes adicionais por tipo.`,
    })
    // Duplicata não é erro de quem preenche, é ruído: dois degraus iguais
    // produziriam o mesmo aviso duas vezes se algum dia alguém lesse a lista
    // sem deduplicar. Some aqui, uma vez, em vez de virar guarda em cada leitor.
    .transform((v) => [...new Set(v)].sort((a, b) => b - a))
    .optional(),
};

// `.partial()` em vez de repetir os doze campos como opcionais: repetir criaria
// duas listas para manter em sincronia, e a segunda envelhece calada.
export const alterarSchema = z.object(camposDoTipo).partial().extend({
  id: z.string().uuid(),
  /**
   * O TEXTO que o cron manda. Vazio/nulo = a frase padrão. Distinto de
   * `reminder_template_name` (nome do template no provedor oficial).
   *
   * Mora só no PATCH de propósito: o tipo nasce com a frase de fábrica, e
   * quem quer outra escreve depois. No POST, o campo nem entra — senão um
   * `""` no nascimento gravaria nulo por cima do default, e a ausência no
   * formulário de criação deixaria de ser ausência.
   *
   * Transforma string em branco em `null` para o PATCH poder VOLTAR ao padrão
   * sem um campo-sentinela: quem apaga o textarea está pedindo o texto de
   * fábrica, não uma mensagem vazia no WhatsApp.
   */
  reminder_body: z
    .string()
    .max(1000, { message: "A mensagem do lembrete cabe em 1000 caracteres." })
    .nullish()
    .transform((v) => (v == null ? v : v.trim() === "" ? null : v.trim())),
  /**
   * Texto de cada extra. Chave = minutos antes. String em branco some do mapa
   * (cai na frase de fábrica). Mora só no PATCH pelo mesmo motivo de
   * `reminder_body`: o tipo nasce sem texto próprio.
   */
  reminder_bodies: z
    .record(
      z.string().regex(/^\d+$/),
      z.string().max(1000, { message: "A mensagem do lembrete cabe em 1000 caracteres." }),
    )
    .optional()
    .transform((v) => {
      if (!v) return v;
      const out: Record<string, string> = {};
      for (const [k, corpo] of Object.entries(v)) {
        const t = corpo.trim();
        if (t) out[k] = t;
      }
      return out;
    }),
});

export const desativarSchema = z.object({ id: z.string().uuid() });

export type AtorDoTipoDeAgendamento = {
  organizationId: string;
  actor: Actor;
  apiTokenId: string | null;
  /** O tradutor da borda. Ausente = identidade (pt-BR). */
  t?: (texto: string) => string;
};

export type RecusaDoTipoDeAgendamento = {
  ok: false;
  code: "validation_failed" | "not_found" | "internal_error";
  status: 404 | 422 | 500;
  message: string;
};

type CanalDoLembrete = { reminder_channel_session_id?: string | null };

/**
 * O CANAL DO LEMBRETE — conferido antes de gravar.
 *
 * Precisa existir, ser desta organização, não estar arquivado e transportar
 * mensagem. Um canal de outro número gravaria uma configuração que o cron nunca
 * usaria; um arquivado, idem. Devolve a recusa discriminada, ou `null`.
 */
export async function recusaDoCanalDoLembrete(
  admin: SupabaseClient,
  organizationId: string,
  campos: CanalDoLembrete,
  t: (texto: string) => string,
): Promise<RecusaDoTipoDeAgendamento | null> {
  if (!campos.reminder_channel_session_id) return null;
  const { data: canal, error: erroCanal } = await admin
    .from("channel_sessions")
    .select("id, provider, archived_at")
    .eq("organization_id", organizationId)
    .eq("id", campos.reminder_channel_session_id)
    .maybeSingle();
  if (erroCanal) {
    return {
      ok: false,
      code: "internal_error",
      status: 500,
      message: t("Não foi possível consultar o canal do lembrete."),
    };
  }
  if (!canal || canal.archived_at || !transportaMensagem(canal.provider)) {
    return {
      ok: false,
      code: "validation_failed",
      status: 422,
      message: t("Escolha um canal de mensagem não arquivado desta organização."),
    };
  }
  return null;
}

/**
 * O MODELO DO LEMBRETE FORA DA JANELA — conferido antes de gravar.
 *
 * Três recusas, cada uma com o que fazer, em vez do erro cru do banco:
 *   - de outra organização (a FK composta da 9092 também recusaria, mas como 500);
 *   - com variável que o lembrete não tem de onde preencher — o cron nunca o
 *     mandaria, e a escolha ficaria gravada sem efeito;
 *   - de OUTRO número que o escolhido no mesmo pedido: o modelo só sai pelo número
 *     dono dele, e o lembrete nunca troca de número sozinho.
 *
 * O status (aprovado, pausado) NÃO é recusa aqui: muda depois da escolha, e quem
 * confere na hora de mandar é o cron (`lerModeloDoLembrete`).
 */
export async function recusaDoModeloDoLembrete(
  admin: SupabaseClient,
  organizationId: string,
  campos: {
    reminder_meta_template_id?: string | null;
    reminder_channel_session_id?: string | null;
  },
  t: (texto: string) => string,
): Promise<RecusaDoTipoDeAgendamento | null> {
  if (!campos.reminder_meta_template_id) return null;
  const { data: modelo, error } = await admin
    .from("meta_templates")
    .select("id, name, language, channel_session_id, parameter_format, components")
    .eq("organization_id", organizationId)
    .eq("id", campos.reminder_meta_template_id)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      code: "internal_error",
      status: 500,
      message: t("Não foi possível consultar o modelo do lembrete."),
    };
  }
  if (!modelo) {
    return {
      ok: false,
      code: "validation_failed",
      status: 422,
      message: t("Escolha um modelo aprovado desta organização."),
    };
  }
  if (variaveisQueOLembretePreenche(modelo) === null) {
    return {
      ok: false,
      code: "validation_failed",
      status: 422,
      message: t(
        "Este modelo não serve para o lembrete: ele só pode ter variáveis de texto no corpo, de {{1}} a {{4}}, sem pular número.",
      ),
    };
  }
  if (
    campos.reminder_channel_session_id &&
    modelo.channel_session_id !== campos.reminder_channel_session_id
  ) {
    return {
      ok: false,
      code: "validation_failed",
      status: 422,
      message: t("O modelo escolhido é de outro número. Escolha um modelo do número que envia os lembretes."),
    };
  }
  return null;
}

export async function alterarTipoDeAgendamento(
  admin: SupabaseClient,
  ator: AtorDoTipoDeAgendamento,
  entrada: z.infer<typeof alterarSchema>,
): Promise<{ ok: true; data: { id: string } } | RecusaDoTipoDeAgendamento> {
  const t = ator.t ?? ((texto: string) => texto);
  const { organizationId, actor, apiTokenId } = ator;
  const { id, ...bruto } = entrada;
  const campos = Object.fromEntries(Object.entries(bruto).filter(([, v]) => v !== undefined));
  if (Object.keys(campos).length === 0) {
    // Recusa em vez de UPDATE vazio: "alterei" sobre nada é a mesma família de
    // mentira que o "Marcado ✓" sem linha no banco.
    return {
      ok: false,
      code: "validation_failed",
      status: 422,
      message: t("Nenhum campo para alterar."),
    };
  }

  const recusaDoCanal = await recusaDoCanalDoLembrete(admin, organizationId, entrada, t);
  if (recusaDoCanal) return recusaDoCanal;
  const recusaDoModelo = await recusaDoModeloDoLembrete(admin, organizationId, entrada, t);
  if (recusaDoModelo) return recusaDoModelo;

  const { data, error } = await admin
    .from("calendar_event_types")
    .update(campos)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  // Sem `t()`: é a mensagem crua do banco, como hoje.
  if (error) {
    return { ok: false, code: "internal_error", status: 500, message: error.message };
  }
  if (!data) {
    return {
      ok: false,
      code: "not_found",
      status: 404,
      message: t("Tipo de agendamento não encontrado."),
    };
  }

  await audit({
    actorUserId: actor.type === "user" ? actor.id : null,
    actorApiTokenId: apiTokenId ?? null,
    action: "agenda.tipo_alterado",
    organizationId,
    resourceType: "calendar_event_types",
    resourceId: id,
    metadata: { campos: Object.keys(campos) },
  });
  return { ok: true, data: { id: data.id } };
}

export async function desativarTipoDeAgendamento(
  admin: SupabaseClient,
  ator: AtorDoTipoDeAgendamento,
  entrada: { id: string },
): Promise<{ ok: true; data: { id: string } } | RecusaDoTipoDeAgendamento> {
  const t = ator.t ?? ((texto: string) => texto);
  const { organizationId, actor, apiTokenId } = ator;

  const { data, error } = await admin
    .from("calendar_event_types")
    .update({ is_active: false })
    .eq("id", entrada.id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  // Sem `t()`: é a mensagem crua do banco, como hoje.
  if (error) {
    return { ok: false, code: "internal_error", status: 500, message: error.message };
  }
  if (!data) {
    return {
      ok: false,
      code: "not_found",
      status: 404,
      message: t("Tipo de agendamento não encontrado."),
    };
  }

  await audit({
    actorUserId: actor.type === "user" ? actor.id : null,
    actorApiTokenId: apiTokenId ?? null,
    action: "agenda.tipo_desativado",
    organizationId,
    resourceType: "calendar_event_types",
    resourceId: entrada.id,
    metadata: {},
  });
  return { ok: true, data: { id: data.id } };
}
