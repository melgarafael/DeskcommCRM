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
 * O estado de "já avisado" não mora em tabela à parte: o item da Central com a
 * mesma `kind` e o mesmo `ref_id` é o registro de que este prazo já pediu
 * gente. É o mesmo desenho do `proposal-promised-not-created`, e ele tem duas
 * vantagens sobre uma coluna nova: a leitura não depende de o aviso estar
 * aberto (resolver o item na Central não faz a rodada seguinte gritar de novo),
 * e o histórico de "quando este prazo gritou" fica onde a pessoa já olha.
 *
 * ═══ E A TRAVA É DA OCASIÃO, NÃO DA TAREFA (#3639) ═══
 *
 * `kind + ref_id` dizia "esta tarefa já pediu gente", e uma tarefa pede gente
 * mais de uma vez: quando OUTRO responsável assume e quando o prazo é ADIADO.
 * Com a identidade no par, o aviso antigo cobria a situação nova — quem
 * assumia nunca era avisado, e adiar para amanhã não rearmava a antecedência
 * de amanhã. A identidade passa a ser a OCASIÃO (categoria + tarefa +
 * responsável + prazo, `OcasiaoDoAviso`), lida de `para_user_id` (0689) e de
 * `task_reminder_due_at` (9038) no item já gravado e da própria linha da
 * tarefa na decisão. Voltar ao responsável/prazo ANTERIOR reencontra a ocasião
 * antiga e não avisa de novo: a ocasião é a mesma, e o histórico fica onde
 * está.
 *
 * ═══ WHATSAPP É CANAL OPCIONAL, E A GUARDA VEM ANTES DA CONSULTA ═══
 *
 * Só com opt-in, e mesmo assim a rodada só TENTA quando a organização tem
 * sessão de canal, a pessoa deixou número e esse número é contato da empresa
 * (`decidirWhatsappDoLembrete`). Sem isso, o motivo do pulo vai para o log e a
 * API do provedor não é chamada — tentar e falhar deixa dúvida no lugar de
 * resposta.
 *
 * ═══ E O CANAL É UM NÚMERO, NÃO UM PERFIL (#3358) ═══
 *
 * O destino deste aviso é sempre um TELEFONE: o número que a pessoa deixou, que
 * a rodada casa com `contacts.phone_number`. Por isso a sessão de envio é
 * pedida COM a preferência por telefone — a organização pode ter Instagram e
 * WhatsApp ligados ao mesmo tempo, e a rede social não alcança um número (o
 * contato de lá é outro endereço). Sem ela a organização que conectou o
 * Instagram primeiro recebia o lembrete numa conversa social, recusada pela
 * janela de 24h fechada.
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
import { HREF_MINHAS_TAREFAS } from "@/lib/tarefas/tipos";

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

/**
 * A OCASIÃO do aviso (#3639) — a identidade da trava.
 *
 * A mesma tarefa pode pedir gente mais de uma vez, e por motivos diferentes:
 * outro responsável assumiu, ou o prazo foi adiado. A trava da #2529 era
 * `kind + ref_id`, então o aviso ANTIGO cobria a situação NOVA: quem assumia
 * nunca era avisado, e adiar não rearmava a antecedência nova.
 *
 * A ocasião é a categoria, a tarefa, QUEM recebeu e o PRAZO que motivou o
 * aviso. Os quatro são lidos dos dois lados da trava — da linha da tarefa na
 * decisão (`ocasiaoDaTarefa`) e do item já gravado na leitura
 * (`ocasiaoDoAvisoSalvo`) —, e é por isso que a coluna `task_reminder_due_at`
 * (9038) existe: o responsável já estava em `para_user_id` (0689), o prazo não
 * estava em lugar nenhum.
 */
export interface OcasiaoDoAviso {
  categoria: TipoDeAvisoDeTarefa;
  tarefaId: string;
  /** Quem recebeu — o mesmo `para_user_id` que o item da Central grava. */
  responsavel: string | null;
  /** O prazo que motivou o aviso, no instante normalizado; nulo = aviso legado. */
  prazo: string | null;
}

/** O item já gravado, no recorte que a trava lê. */
export interface AvisoGravado {
  kind: string;
  ref_id: string | null;
  para_user_id: string | null;
  task_reminder_due_at: string | null;
}

/**
 * O prazo como CHAVE: o instante, e não o texto que veio do banco.
 *
 * `crm_tasks.due_date` volta do PostgREST com o deslocamento que o cliente
 * mandou (`2026-10-28T15:30:00+00:00`), e o mesmo instante gravado uma vez com
 * `+00:00` e outra com `Z` viraria DUAS ocasiões — o rearme do #3639 viraria
 * aviso repetido a cada rodada, que é o defeito oposto ao que ele conserta.
 *
 * Data ilegível fica como veio: ela nunca decide o aviso (a régua
 * `decidirLembreteDeTarefa` já a descarta), e inventar um instante para ela
 * seria pior que repetir o texto — duas linhas tortas diferentes continuam
 * sendo ocasiões diferentes, como devem.
 */
export function prazoDaOcasiao(prazo: string | null | undefined): string | null {
  if (!prazo) return null;
  const ms = Date.parse(prazo);
  return Number.isNaN(ms) ? prazo : new Date(ms).toISOString();
}

/** A ocasião que a TAREFA pede AGORA — o lado da decisão. */
export function ocasiaoDaTarefa(tarefa: TarefaLida, categoria: TipoDeAvisoDeTarefa): OcasiaoDoAviso {
  return {
    categoria,
    tarefaId: tarefa.id,
    responsavel: tarefa.assigned_to,
    prazo: prazoDaOcasiao(tarefa.due_date),
  };
}

/** A ocasião que um aviso JÁ GRAVADO registra — o lado da leitura. */
export function ocasiaoDoAvisoSalvo(aviso: AvisoGravado): OcasiaoDoAviso | null {
  // `ref_id` nulo é aviso sem referência (a varredura nem os traz, mas a
  // função é pública): sem tarefa não há ocasião a comparar.
  if (!aviso.ref_id) return null;
  return {
    categoria: aviso.kind as TipoDeAvisoDeTarefa,
    tarefaId: aviso.ref_id,
    responsavel: aviso.para_user_id,
    prazo: prazoDaOcasiao(aviso.task_reminder_due_at),
  };
}

/** A trava de "já avisado": a ocasião inteira, numa string. */
export function chaveDoAviso(ocasiao: OcasiaoDoAviso): string {
  // `|` não aparece em kind, uuid nem ISO-8601: a chave não vira ambígua.
  return [ocasiao.categoria, ocasiao.tarefaId, ocasiao.responsavel ?? "", ocasiao.prazo ?? ""].join("|");
}

/** As ocasiões que já viraram item da Central — a leitura da trava, pura. */
export function chavesJaAvisadas(avisos: readonly AvisoGravado[]): Set<string> {
  const chaves = new Set<string>();
  for (const aviso of avisos) {
    const ocasiao = ocasiaoDoAvisoSalvo(aviso);
    if (ocasiao) chaves.add(chaveDoAviso(ocasiao));
  }
  return chaves;
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
    // A trava é da OCASIÃO (#3639): responsável novo ou prazo novo é aviso novo;
    // a mesma ocasião não repete — nem depois de resolvida na Central (#2529).
    if (input.jaAvisados.has(chaveDoAviso(ocasiaoDaTarefa(tarefa, categoria)))) continue;
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
 *
 * `task_reminder_due_at` (9038) é o PRAZO que originou o aviso, e é o que
 * transforma o item na trava da OCASIÃO (#3639): a rodada seguinte compara este
 * instante com o prazo atual da tarefa, e um prazo novo rearma o lembrete. A
 * gravação e a leitura passam pela MESMA conta (`ocasiaoDaTarefa` /
 * `ocasiaoDoAvisoSalvo`) — é o que o teste de ida-e-volta prende.
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
    task_reminder_due_at: prazoDaOcasiao(tarefa.due_date),
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
  //
  // O recorte é a OCASIÃO (#3639), não o par `kind + ref_id`: o prazo que
  // originou o aviso (`task_reminder_due_at`, 9038) e o responsável que o
  // recebeu (`para_user_id`, 0689) vêm junto, senão o aviso antigo de um prazo
  // ou de uma pessoa cobre o prazo/pessoa novo.
  const { data: avisos, error: erroAvisos } = await admin
    .from("agent_inbox_items")
    .select("kind, ref_id, para_user_id, task_reminder_due_at")
    .in("ref_id", linhas.map((t) => t.id))
    .in("kind", [...TIPOS_DE_AVISO_DE_TAREFA]);
  if (erroAvisos) throw new Error(`query_avisos_failed: ${erroAvisos.message}`);
  const jaAvisados = chavesJaAvisadas((avisos ?? []) as AvisoGravado[]);

  const decididos = lembretesDaRodada({ tarefas: linhas, preferencias, jaAvisados, membrosAtivos }, agora);
  let avisadas = 0;

  for (const { tarefa, categoria } of decididos) {
    const responsavel = tarefa.assigned_to as string;
    const texto = textoDoAvisoDeTarefa(categoria, tarefa);

    // IN-APP: o item da Central do RESPONSÁVEL (`para_user_id`, 0689). A trava
    // de "já avisado" mora nele — e, desde a 9038, ele também REGISTRA a
    // ocasião (o prazo que a motivou), então a rodada seguinte sabe distinguir
    // "esta pessoa já foi avisada deste prazo" de "esta tarefa já avisou".
    // Duas rodadas concorrentes na MESMA ocasião caem no índice único
    // `inbox_task_reminder_ocasiao_unique`: a perdedora não é erro, é a trava
    // trabalhando — o aviso já saiu pela vencedora.
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
      if (erroInbox.code === "23505") {
        pular("corrida_na_mesma_ocasiao");
        continue;
      }
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
        href: HREF_MINHAS_TAREFAS,
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
      // O DESTINO DESTA RODADA É UM TELEFONE (#3358) — o número que a pessoa
      // deixou, casado logo abaixo com `contacts.phone_number`. Sem a
      // preferência, a porta devolvia a sessão `WORKING` mais ANTIGA da
      // organização, e numa organização que conectou o Instagram/Facebook antes
      // do WhatsApp a escolhida era a social: o lembrete era gravado numa
      // conversa de Instagram e recusado pela janela de 24h fechada. O `create`
      // de contato e a conversa compartilhada ainda chamam sem a opção
      // (continuação do #3358).
      const canalId = await sessaoProntaParaEnvio(admin, tarefa.organization_id, { preferirTelefone: true });
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
