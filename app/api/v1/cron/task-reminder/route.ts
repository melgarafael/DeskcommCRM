/**
 * O LEMBRETE DE PRAZO DA TAREFA (#2529) — a varredura.
 *
 * A tarefa vencida só aparecia em vermelho para quem ABRIA a lista de tarefas.
 * Quem não abria perdia o prazo em silêncio, e o silêncio é o defeito caro:
 * "retorno combinado com o cliente passa do prazo sem aviso" é contrato furado.
 * Este cron transforma o relógio em acontecimento, do mesmo jeito que
 * `agenda-reminder` faz com o compromisso e `lead-time-triggers` com o silêncio
 * do negócio.
 *
 * ═══ O QUE ELE LÊ, E POR QUÊ NÃO É A CHECAGEM DA #2500 ═══
 *
 * O cron `proposal-promised-not-created` já sinaliza tarefa vencida — mas só
 * a de `source_kind = promised_proposal`, e pelo critério dele: promessa de
 * proposta sem proposta criada. Aqui não se repete nenhuma daquela checagem
 * (nem `due_date < agora`, nem `status != done` num sentido novo): o recorte é
 * o da PRÓPRIA tarefa, para toda tarefa com prazo e responsável. O push vai
 * ao aparelho do RESPONSÁVEL, e o item da Central também é SÓ dele
 * (`para_user_id`, migration 0689, doc de decisão 162): o colega não vê o
 * prazo do outro no sino, e o "Marcar todos resolvidos" de um não resolve o
 * do outro. Os dois convivem: uma tarefa de proposta prometida pode receber os
 * dois avisos, e ambos são certos.
 *
 * ═══ AS DUAS CATEGORIAS, E A ORDEM DELAS ═══
 *
 *   `task_due`     — falta pouco, dentro da janela que a PESSOA escolheu
 *                    (15 min, 1 h que é o padrão, ou 1 dia);
 *   `task_overdue` — venceu sem conclusão.
 *
 * A régua é `decidirLembreteDeTarefa` (`lib/tarefas/preferencia-de-lembrete.ts`),
 * pura, exportada e testada sem banco. Vencimento vem antes de antecedência, e
 * vencida não recai em `task_due`: um só aviso por passo.
 *
 * ═══ A PREFERÊNCIA É DA PESSOA, E ESTÁ NO SERVIDOR ═══
 *
 * O cron roda com o site fechado: não existe `localStorage` para ler. A escolha
 * mora em `raw_user_meta_data.lembretes_de_tarefa` — o mesmo sítio do perfil,
 * por PESSOA — e o padrão é o do produto: `task_due` ligado, `task_overdue`
 * desligado (repetição é opt-in), WhatsApp desligado. Preferência desligada não
 * manda nada, e "nada" inclui o push: a régua decide ANTES de qualquer escrita.
 *
 * ═══ A TRAVA DE "JÁ AVISADO" É O PRÓPRIO ITEM DA CENTRAL ═══
 *
 * Sem migration nova para estado: o item aberto com o mesmo `kind` e o mesmo
 * `ref_id` é o registro de que este prazo já pediu gente. É o mesmo desenho do
 * `proposal-promised-not-created`, e ele tem duas vantagens sobre uma coluna
 * nova: a leitura não depende de o aviso estar aberto (resolver o item na
 * Central não faz a rodada seguinte gritar de novo), e o histórico de "quando
 * este prazo gritou" fica onde a pessoa já olha.
 *
 * ═══ WHATSAPP É CANAL OPCIONAL, E A GUARDA VEM ANTES DA CONSULTA ═══
 *
 * Só com opt-in, e mesmo assim a rodada só TENTA quando a organização tem
 * sessão de canal, a pessoa deixou número e esse número é contato da empresa
 * (`decidirWhatsappDoLembrete`). Sem isso, o motivo do pulo vai para o log e a
 * API do provedor não é chamada — tentar e falhar deixa dúvida no lugar de
 * resposta.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { espacarEnvio } from "@/lib/automation/throttle";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { truncar } from "@/lib/notifications/push_payload";
import { enviarPushAoUsuario } from "@/lib/notifications/web_push";
import { idsDeOrgsParadas, OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ANTCEDENCIAS_DE_TAREFA_MIN,
  TIPOS_DE_AVISO_DE_TAREFA,
  decidirLembreteDeTarefa,
  decidirWhatsappDoLembrete,
  lerPreferenciaDeLembrete,
  textoDoAvisoDeTarefa,
  type PreferenciaDeLembrete,
  type TipoDeAvisoDeTarefa,
} from "@/lib/tarefas/preferencia-de-lembrete";

export const dynamic = "force-dynamic";

/**
 * A maior antecedência que a tela oferece: nada além dela é candidato.
 *
 * O mesmo número como teto e como corte do SQL: uma tarefa que vence daqui a
 * dois dias não pede ninguém agora, e trazê-la para a memória só para descartá-la
 * pagaria a varredura duas vezes.
 */
const MAIOR_JANELA_MIN = Math.max(...ANTCEDENCIAS_DE_TAREFA_MIN);

/** Teto de tarefas examinadas por rodada. */
const LIMITE_DA_VARREDURA = 200;

/**
 * Até quando uma vencida ainda é candidata a `task_overdue`.
 *
 * Sem piso, a consulta ordenada por prazo devolve primeiro as vencidas mais
 * antigas — e tarefa esquecida em aberto não sai da lista nunca. 200 delas
 * (somadas de todas as organizações) tomavam o teto inteiro, e a tarefa que
 * vence daqui a 30 minutos deixava de ser examinada. O aviso de vencida é do
 * MOMENTO em que o prazo passa; com o cron a cada 5 minutos, um dia de folga
 * cobre agendador parado sem trazer de volta o que venceu há semanas.
 */
// ponytail: piso fixo de 1 dia. Limite que resta: as 200 vagas ainda são
// divididas por TODA tarefa aberta na janela de ±24 h (as já avisadas, as de org
// suspensa, as de membro revogado e as vencidas de quem deixou task_overdue
// desligado). Com 200 delas vencidas nas últimas 24 h, a de daqui a 30 min volta a
// não ser examinada. Próximo passo: separar a consulta da janela futura da
// consulta da vencida, cada uma com o seu teto.
const FOLGA_DA_VENCIDA_MIN = 1440;

/** O recorte de prazo da consulta — puro, para o teste prender o sentido. */
export function janelaDaVarredura(agora: Date): { piso: string; corte: string } {
  return {
    piso: new Date(agora.getTime() - FOLGA_DA_VENCIDA_MIN * 60_000).toISOString(),
    corte: new Date(agora.getTime() + MAIOR_JANELA_MIN * 60_000).toISOString(),
  };
}

export interface TarefaLida {
  id: string;
  organization_id: string;
  assigned_to: string | null;
  due_date: string | null;
  status: string;
  title: string;
}

export interface LembreteDecidido {
  tarefa: TarefaLida;
  categoria: TipoDeAvisoDeTarefa;
}

/** A trava de "já avisado": o mesmo par que o item da Central grava. */
export function chaveDoAviso(categoria: TipoDeAvisoDeTarefa, tarefaId: string): string {
  return `${categoria}:${tarefaId}`;
}

/**
 * Quem recebe aviso nesta rodada — puro, exportado, sem banco.
 *
 * As três recusas que ele faz são as que o teste prende, e nenhuma delas é
 * consultiva: tudo o que ela precisa já está na mão. A preferência que não veio
 * (`preferencias.get` devolvendo `undefined`) cai no PADRÃO do produto, e não em
 * "sem preferência = silêncio": pessoa que nunca abriu a tela de notificações
 * continua sendo avisada de prazo, como sempre foi o esperado.
 */
export function lembretesDaRodada(
  input: {
    tarefas: readonly TarefaLida[];
    /** Preferência por RESPONSÁVEL (`assigned_to`), vinda do metadata de cada um. */
    preferencias: ReadonlyMap<string, PreferenciaDeLembrete>;
    /** Pares `${categoria}:${tarefaId}` que já viraram item da Central. */
    jaAvisados: ReadonlySet<string>;
    /** Pares `${organization_id}:${user_id}` com vínculo ATIVO (`revoked_at` nulo). */
    membrosAtivos: ReadonlySet<string>;
  },
  agora: Date,
): LembreteDecidido[] {
  const decididos: LembreteDecidido[] = [];
  for (const tarefa of input.tarefas) {
    // Sem responsável não há a quem avisar — e o aviso cairia na Central sem
    // dono, que é ruído que ensina a ignorar a Central (a mesma razão de
    // `criarTarefaInterna` recusar tarefa sem dono).
    if (!tarefa.assigned_to) continue;
    // Revogar um membro não limpa `assigned_to`: só quem ainda é da equipe DA
    // ORGANIZAÇÃO DA TAREFA recebe — a régua do `send_email` (#2794) e do
    // `assign-owner`.
    if (!input.membrosAtivos.has(`${tarefa.organization_id}:${tarefa.assigned_to}`)) continue;
    const preferencia = input.preferencias.get(tarefa.assigned_to) ?? lerPreferenciaDeLembrete(undefined);
    const categoria = decidirLembreteDeTarefa(tarefa, agora, preferencia);
    if (!categoria) continue;
    if (input.jaAvisados.has(chaveDoAviso(categoria, tarefa.id))) continue;
    decididos.push({ tarefa, categoria });
  }
  return decididos;
}

/**
 * A linha da Central de um lembrete — pura, para o teste prender o DONO.
 *
 * `para_user_id` é o responsável (0689): sem ele o aviso volta a ser da equipe
 * inteira, que é o defeito que o doc de decisão 162 fechou. O título é o nome
 * da tarefa (ver o comentário no insert).
 */
export function avisoDaCentral({ tarefa, categoria }: LembreteDecidido) {
  return {
    organization_id: tarefa.organization_id,
    para_user_id: tarefa.assigned_to,
    kind: categoria,
    severity: "warn",
    title: textoDoAvisoDeTarefa(categoria, tarefa).corpo,
    ref_kind: "task",
    ref_id: tarefa.id,
  };
}

interface Rodada {
  examinadas: number;
  avisadas: number;
  pulados: Record<string, number>;
}

async function rodar(admin: ReturnType<typeof createAdminClient>, requestId: string): Promise<Rodada> {
  const agora = new Date();
  const { piso, corte } = janelaDaVarredura(agora);

  // ORGANIZAÇÃO SUSPENSA NÃO LÊ NADA. A suspensão não tem exceção no
  // CLAUDE.md, e um lembrete de tarefa não é o porto que burla ela: o filtro é
  // na consulta, não depois do aviso (a cerca que olha isto é
  // `tests/unit/cron-respeita-org-operante.test.ts`).
  const paradas = new Set(await idsDeOrgsParadas(admin));

  const { data: tarefas, error: erroTarefas } = await admin
    .from("crm_tasks")
    .select("id, organization_id, assigned_to, due_date, status, title")
    .in("status", ["pending", "in_progress"])
    .not("assigned_to", "is", null)
    .not("due_date", "is", null)
    .gte("due_date", piso)
    .lte("due_date", corte)
    .order("due_date", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);
  if (erroTarefas) throw new Error(`query_tarefas_failed: ${erroTarefas.message}`);

  // O corte das suspensas é feito AQUI, e não no SQL: encadear `.not(...)` no
  // construtor do PostgREST explode a inferência de tipo (TS2589) deste repo.
  // O efeito é o mesmo — a suspensa não recebe item da Central, nem push, nem
  // WhatsApp — e o preço é modesto e pago só por rodada: as tarefas dela podem
  // ocupar parte do teto de 200, que é a contagem EXAMINADAS, não a AVISADAS.
  const linhas = ((tarefas ?? []) as TarefaLida[]).filter(
    (tarefa) => !paradas.has(tarefa.organization_id),
  );
  const pulados: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + 1;
  };
  if (linhas.length === 0) return { examinadas: 0, avisadas: 0, pulados };

  // ─── A preferência de cada RESPONSÁVEL, uma leitura por pessoa ────────────
  //
  // O metadata vem de `auth.users`, e o cron é de todas as organizações: o
  // mesmo responsável com tarefas em N linhas paga UMA leitura. Falha de
  // leitura não silencia ninguém — cai no padrão do produto, que é avisar.
  const responsaveis = [...new Set(linhas.map((t) => t.assigned_to as string))];
  const preferencias = new Map<string, PreferenciaDeLembrete>();
  for (const responsavel of responsaveis) {
    let metadata: unknown = undefined;
    try {
      const { data, error } = await admin.auth.admin.getUserById(responsavel);
      if (error) throw new Error(error.message);
      metadata = data.user?.user_metadata;
    } catch (err) {
      logger.warn("[task-reminder] preferência ilegível — usando o padrão", {
        user_id: responsavel,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
    preferencias.set(responsavel, lerPreferenciaDeLembrete(metadata));
  }

  // ─── Quem ainda é da equipe ───────────────────────────────────────────────
  //
  // Consulta que não voltou não é "ninguém saiu": a rodada falha inteira e não
  // avisa ninguém, em vez de avisar quem pode já não ser da empresa.
  const { data: vinculos, error: erroVinculos } = await admin
    .from("user_organizations")
    .select("organization_id, user_id")
    .in("user_id", responsaveis)
    .is("revoked_at", null);
  if (erroVinculos) throw new Error(`query_vinculos_failed: ${erroVinculos.message}`);
  const membrosAtivos = new Set(
    (vinculos ?? []).map((v) => `${v.organization_id as string}:${v.user_id as string}`),
  );

  // ─── A trava de "já avisado", lida do próprio item da Central ─────────────
  const { data: avisos, error: erroAvisos } = await admin
    .from("agent_inbox_items")
    .select("kind, ref_id")
    .in("ref_id", linhas.map((t) => t.id))
    .in("kind", [...TIPOS_DE_AVISO_DE_TAREFA]);
  if (erroAvisos) throw new Error(`query_avisos_failed: ${erroAvisos.message}`);
  const jaAvisados = new Set(
    (avisos ?? []).map((a) => chaveDoAviso(a.kind as TipoDeAvisoDeTarefa, a.ref_id as string)),
  );

  const decididos = lembretesDaRodada({ tarefas: linhas, preferencias, jaAvisados, membrosAtivos }, agora);
  let avisadas = 0;

  for (const { tarefa, categoria } of decididos) {
    const responsavel = tarefa.assigned_to as string;
    const texto = textoDoAvisoDeTarefa(categoria, tarefa);

    // IN-APP: o item da Central do RESPONSÁVEL (`para_user_id`, 0689). A trava
    // de "já avisado" mora nele — se o INSERT cair por corrida com outra rodada,
    // o efeito é um segundo aviso, nunca um aviso perdido.
    //
    // O título do item é o NOME DA TAREFA, e não a frase do push: a Central
    // mostra o título cru (dado de gente, `AgentInboxList.tsx`) e logo abaixo o
    // rótulo do kind já traduzido — "Uma tarefa está perto do vencimento" em PT
    // no título ficaria sem tradução para quem usa espanhol, e repetido em
    // português. O push não tem rótulo, por isso leva a frase (doc 162).
    const { error: erroInbox } = await admin
      .from("agent_inbox_items")
      .insert(avisoDaCentral({ tarefa, categoria }));
    if (erroInbox) {
      logger.error("[task-reminder] aviso na Central falhou", {
        organization_id: tarefa.organization_id,
        task_id: tarefa.id,
        error: erroInbox.message,
        requestId,
      });
      pular("aviso_falhou");
      continue;
    }

    // PUSH: o MESMO caminho do push de tarefa criada (`criarTarefaInterna`) —
    // inscrição do aparelho da PESSOA, e não da organização: este aviso é do
    // responsável, não da empresa. Fire-and-forget quanto a erro: o aviso já
    // está na Central, e o push recusado não pode desfazer o que foi decidido.
    try {
      await enviarPushAoUsuario(tarefa.organization_id, responsavel, {
        title: texto.titulo,
        body: truncar(texto.corpo),
        tag: `task:${tarefa.id}`,
        href: "/app/tasks",
      });
    } catch (err) {
      logger.warn("[task-reminder] push falhou", {
        organization_id: tarefa.organization_id,
        task_id: tarefa.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }

    // WHATSAPP: canal OPCIONAL, e a ordem das portas é a ordem de custo.
    //
    // Sem opt-in a consulta nem sai do canto: não se busca canal da
    // organização, não se busca contato, não se abre conversa. Com opt-in, o
    // canal vem de `sessaoProntaParaEnvio` (a mesma porta que a automação de
    // mensagens usa) — sem sessão de canal da organização a rodada NEM TENTA.
    const pref = preferencias.get(responsavel) ?? lerPreferenciaDeLembrete(undefined);
    if (pref.whatsapp) {
      const canalId = await sessaoProntaParaEnvio(admin, tarefa.organization_id);
      const telefone = pref.whatsapp_numero ?? null;
      let contatoId: string | null = null;
      // A tela grava só dígitos (`5511999990000`) e `contacts.phone_number`
      // guarda E.164 com `+` (CHECK `contacts_phone_e164_format`): o `.eq` com o
      // número cru nunca casava. As variantes devolvem a forma com `+` e a
      // contraparte com/sem o nono dígito, como a importação de contatos faz.
      const variantes = telefone ? phoneLookupVariants(telefone) : [];
      if (canalId && variantes.length > 0) {
        // O NÚMERO é o da pessoa que optou, e o contato tem de ser da MESMA
        // organização — a cerca do lembrete de compromisso, na prática: sem o
        // recorte por org esta linha viria a organização A mandando mensagem
        // para contato de B.
        const { data } = await admin
          .from("contacts")
          .select("id")
          .eq("organization_id", tarefa.organization_id)
          .in("phone_number", variantes)
          .limit(1)
          .maybeSingle();
        contatoId = (data as { id: string } | null)?.id ?? null;
      }

      const decisao = decidirWhatsappDoLembrete({
        pref,
        temCanal: Boolean(canalId),
        temTelefone: Boolean(telefone),
        temContato: Boolean(contatoId),
      });

      if (!decisao.enviar) {
        // O pulo nunca é silencioso — a mesma régua do `agenda-reminder`.
        pular(`whatsapp_${decisao.motivo}`);
      } else if (canalId && contatoId) {
        try {
          await espacarEnvio(canalId);
          const conversaId = await ensureConversation(admin, tarefa.organization_id, contatoId, canalId);
          await sendMessageHandler(
            admin,
            {
              organization_id: tarefa.organization_id,
              actor: { type: "webhook_source", id: tarefa.id },
              requestId: `task-reminder:${tarefa.id}`,
            },
            { conversation_id: conversaId, type: "text", body: texto.corpo } as Parameters<
              typeof sendMessageHandler
            >[2],
          );
        } catch (err) {
          // A organização parou entre a leitura e o envio: não é erro, é a
          // suspensão (a porta de saída lança `OrgNaoOperanteError`). O aviso da
          // Central e o push JÁ saíram e não voltam; o WhatsApp desta rodada é o
          // que se perde — sem retentativa, porque a própria suspensão já nega a
          // rodada seguinte.
          if (err instanceof OrgNaoOperanteError) {
            pular("org_nao_operante");
            continue;
          }
          logger.error("[task-reminder] WhatsApp falhou", {
            organization_id: tarefa.organization_id,
            task_id: tarefa.id,
            error: err instanceof Error ? err.message : String(err),
            requestId,
          });
          pular("whatsapp_falhou");
        }
      }
    }

    avisadas += 1;
  }

  return { examinadas: linhas.length, avisadas, pulados };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: Rodada;
  try {
    resultado = await rodar(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[task-reminder] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to check task reminders.", 500, { requestId });
  }

  // Rodada que não avisou ninguém NÃO é mutação e não audita — a lei está no
  // CLAUDE.md §Audit log (`cron-audita-so-quando-ha-efeito` varre as rotas deste
  // diretório atrás de `audit` incondicional).
  if (resultado.avisadas > 0) {
    void audit({
      action: "task.reminder_batch",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }
  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
