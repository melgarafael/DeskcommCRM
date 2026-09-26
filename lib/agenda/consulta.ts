import { googleRpc } from "./google/sync-store";
import { lerCorposDoLembrete } from "./lembretes";
/**
 * OS HORÁRIOS LIVRES DE UMA ORGANIZAÇÃO — a coleta, num lugar só.
 *
 * ─── Por que este módulo existe ──────────────────────────────────────────────
 *
 * `horariosLivres` (`./horarios-livres`) é função PURA: recebe jornada, exceções,
 * ocupados e tipo já prontos. Alguém precisa buscar isso no banco, e essa coleta
 * nasceu inline no `GET` de `app/api/v1/agenda/horarios-livres/route.ts`.
 *
 * Só que a rota não é o único consumidor. As ferramentas MCP oferecem horário ao
 * cliente pela conversa, e elas não têm `NextRequest`, nem cookie, nem
 * `requireRole` — têm `organizationId` já resolvido e um client de service role.
 * Copiar a coleta para dentro da tool faria a IA e a tela responderem por regras
 * diferentes sobre o MESMO horário, que é o defeito que o cabeçalho de
 * `lib/mcp/tools/retencao.ts` descreve em voz alta: *"o sistema mentiria para um
 * dos dois"*. O sintoma seria a IA oferecendo um horário que a tela não mostra.
 *
 * Então a coleta mora aqui, e a rota passou a chamá-la. Mesmo caminho para os
 * dois, e o dia em que a regra mudar ela muda uma vez.
 *
 * ─── ⚠️ O CLIENT VEM DE FORA, E ISSO TEM PREÇO ───────────────────────────────
 *
 * A rota passa o client de SESSÃO (a RLS filtra sozinha). A ferramenta MCP passa
 * o ADMIN, que **bypassa a RLS**. Por isso TODA query aqui filtra
 * `organization_id` explicitamente — não é redundância com a RLS, é a única
 * proteção que existe no caminho do service role (anti-pattern nº 10 do
 * `CLAUDE.md`). Quem acrescentar query neste arquivo filtra também, sempre.
 *
 * ─── Recusa: dois textos, duas plateias ──────────────────────────────────────
 *
 * `motivoParaOperador` pode nomear campo e pessoa — quem lê é quem configura.
 * `motivoParaCliente` vai para o modelo e pode chegar ao cliente final: nada de
 * nome de campo, e ele diz o que fazer em seguida em vez de só negar. É a mesma
 * separação que `lerJornadaDoBanco` já faz, e pela mesma razão (DECISÃO 20).
 *
 * ─── ⚠️ O GOOGLE DO DONO DA AGENDA VEM DE FUNÇÃO, NÃO DE TABELA (issue #879) ──
 *
 * A junção com `calendar_connections` é o caminho até o Google Agenda, e a RLS
 * dessa tabela só mostra a conexão ao PRÓPRIO dono e a `manager` para cima (ela
 * guarda token OAuth):
 *
 *     create policy calendar_connections_dono_ou_manager_read ... using (
 *       ... and (user_id = auth.uid()
 *                or public.fn_role_at_least(organization_id, 'manager')))
 *
 * Consequência medida (Postgres descartável, `baseline.sql`, a MESMA agenda):
 * dono vê 1 evento do Google, gerente vê 1, **atendente vê 0**. Com o client de
 * sessão, o Atendente que marca na agenda de outra pessoa conferia ocupação
 * contra uma lista sem o Google dela — na grade E no encaixe — e marcava por
 * cima de um compromisso pessoal que existe.
 *
 * As duas leituras do Google (os eventos, em `coletaOQueOcupa`, e a situação
 * das conexões, em `horariosLivresDaOrg`) saem por RPC —
 * `fn_agenda_ocupacao_google_do_dono` e `fn_agenda_conexoes_google_do_dono`
 * (migration 0260) — pelo MESMO client que veio de fora. São `security definer`
 * que atravessam só a RLS da conexão, conferem o pertencimento no corpo
 * (`fn_user_org_ids()`, a régua das policies) e filtram o dono; o que devolvem é
 * ocupação (início, fim, transparência, situação), nunca título, descrição ou
 * participantes.
 *
 * ⚠️ NÃO troque por `createAdminClient()` aqui. Foi a primeira forma deste
 * conserto (PR #883): o admin ficava escondido dentro de uma coleta que recebe o
 * client de fora, então a rota que passa a SESSÃO recebia sem saber uma leitura
 * com service role, guardada só pelo `.eq("organization_id")` — o que
 * `lib/supabase/admin.ts` proíbe em fluxo normal de usuário. E todo teste que
 * passava pela coleta sem dublar o admin ia para a rede.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";

import { diaLocalISO, instanteDe } from "./fuso";
import { horariosLivres, type ExcecaoDeData, type Slot } from "./horarios-livres";
import { lerJornadaDoBanco } from "./jornada";
import {
  agendaExternaNuncaLida,
  ocupadosDoDono,
  type LinhaDeAgendamento,
  type LinhaDeEventoExterno,
  type OQueOcupa,
} from "./ocupados";
import type { SituacaoDaConexao, SituacaoDoAgendamento } from "./tipos";

/** Teto de dias por consulta: uma varredura de ano inteiro é erro de chamada, não pedido. */
export const MAXIMO_DE_DIAS = 62;

export type CodigoDeRecusaDaConsulta =
  | "tipo_desconhecido"
  | "tipo_desativado"
  | "sem_responsavel"
  | "jornada_mal_configurada"
  | "erro_interno";

export interface ParametrosDaConsulta {
  /**
   * O tipo, por id OU por slug — exatamente um dos dois.
   *
   * A rota fala `uuid` porque a tela tem o id na mão. A ferramenta MCP fala
   * SLUG porque o modelo não tem, e o cabeçalho de `calendar_event_types` diz
   * por quê: o slug existe para "dar à IA um handle que ela não alucina, ao
   * contrário de um uuid". Resolver os dois aqui evita uma segunda consulta
   * só para traduzir.
   */
  eventTypeId?: string | null;
  eventTypeSlug?: string | null;
  /** Ausente = o responsável padrão do tipo. */
  ownerUserId?: string | null;
  de: Date;
  ate: Date;
  /** INJETADO, como em `horariosLivres`. Relógio lido aqui dentro é o defeito que `janela-do-canal.ts` documenta. */
  agora: Date;
  /**
   * Um agendamento que NÃO conta como ocupação — o que está sendo REMARCADO.
   *
   * Ele ocupa o horário de ONDE SAI, não o de DESTINO. Sem o intervalo, o próprio
   * compromisso já não atrapalhava a si mesmo por acaso: a janela dele não cruza a
   * janela pedida. Com intervalo, a coleta alarga para trás/para frente e o
   * horário de saída passa a cruzar a janela do destino — a IA remarcando para
   * logo depois do próprio fim levava 422 `agenda_horario_indisponivel` por causa
   * de si mesma (#1084). Quem remarca diz quem remarcar; quem só OFERECE horário
   * (rota, ferramenta MCP) não passa nada, e a grade segue contando tudo.
   */
  ignorarAgendamentoId?: string;
}

export type ResultadoDaConsulta =
  | {
      ok: true;
      slots: Slot[];
      fusoDaRegra: string;
      /** DECISÃO 1.1: "não publiquei" e "não tenho vaga" não podem chegar como a mesma lista vazia. */
      publicouHorarios: boolean;
      /** DECISÃO 20.2: o fuso veio do default, ninguém escolheu — e a IA oferece horário com ele. */
      fusoSuposto: boolean;
      fontesDefasadas: SituacaoDaConexao[];
      /**
       * NENHUMA conexão viva jamais sincronizou.
       *
       * Diferente de `fontesDefasadas`: lá a conexão já trouxe eventos e parou de
       * atualizar; aqui ela nunca trouxe NADA, e a lista de ocupados pode estar
       * vazia por ninguém ter perguntado — não por estar livre.
       *
       * ⚠️ Vive AQUI, e não na rota, porque quem mais precisa dele é a IA: uma
       * tela que oferece horário de agenda nunca lida deixa um humano estranhar;
       * um agente que o oferece MARCA por cima da cirurgia e confirma ao cliente.
       */
      agendaExternaNuncaLida: boolean;
      googleCoberturaParcial: boolean;
    }
  | {
      ok: false;
      codigo: CodigoDeRecusaDaConsulta;
      /** Nomeia campo e pessoa. Plateia: quem configura. */
      motivoParaOperador: string;
      /** Sem nome de campo, e diz o que fazer. Plateia: o modelo, e por tabela o cliente. */
      motivoParaCliente: string;
    };

/**
 * Um dia em milissegundos — a margem de cada lado com que os dias locais são
 * visitados, a MESMA de `horarios-livres.ts` (lá `naoAntesDe - DIA` …
 * `naoDepoisDe + DIA`). A coleta tem que cobrir a visita inteira; margem menor
 * de um lado devolve dia que a grade pergunta e o mapa não tem.
 */
const DIA = 86_400_000;

/**
 * O intervalo antes/depois do atendimento é regra de OFERTA — quem o aplica é o
 * motor, inflando cada candidato (`horarios-livres.ts`). A COLETA, porém, precisa
 * enxergar o que esse intervalo alcança: um compromisso que termina dentro dele
 * não cruza a janela pedida e ficava invisível. Sem ele, a ESCRITA aceitava o
 * horário que a LEITURA escondia (issue #876). Alargar só a coleta põe as duas
 * pontas na mesma régua sem duplicar regra: quem decide continua sendo o motor.
 */
const MINUTO = 60_000;

const NAO_OFERECA =
  "Não ofereça horários e não diga que está sem vaga — avise que alguém da equipe confirma o horário.";

export async function horariosLivresDaOrg(
  supabase: SupabaseClient,
  organizationId: string,
  params: ParametrosDaConsulta,
): Promise<ResultadoDaConsulta> {
  const { data: tipo, error: erroTipo } = await supabase
    .from("calendar_event_types")
    .select(
      "id, name, is_active, duration_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, slot_interval_minutes, booking_window_days, default_owner_user_id",
    )
    .eq("organization_id", organizationId)
    .eq(params.eventTypeSlug ? "slug" : "id", params.eventTypeSlug ?? params.eventTypeId ?? "")
    .maybeSingle();

  if (erroTipo) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: erroTipo.message,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }
  if (!tipo) {
    return {
      ok: false,
      codigo: "tipo_desconhecido",
      motivoParaOperador: "Tipo de agendamento não encontrado.",
      // Devolve o que foi pedido: sem isso o modelo não sabe QUAL nome errou, e
      // a recusa que não ensina faz ele tentar de novo igual.
      motivoParaCliente:
        `Não existe atendimento chamado "${params.eventTypeSlug ?? params.eventTypeId ?? ""}". ` +
        "Pergunte à pessoa que tipo de atendimento ela quer e use um dos tipos que a organização oferece.",
    };
  }
  if (!tipo.is_active) {
    return {
      ok: false,
      codigo: "tipo_desativado",
      motivoParaOperador: `"${tipo.name}" está desativado.`,
      motivoParaCliente: `"${tipo.name}" não está sendo agendado no momento. ${NAO_OFERECA}`,
    };
  }

  const donoId = params.ownerUserId ?? tipo.default_owner_user_id;
  if (!donoId) {
    // Sem dono não há jornada, e sem jornada não há horário. Lista vazia aqui
    // faria a tela dizer "nenhum horário disponível" para uma configuração
    // incompleta — o erro nomeado é o que leva alguém a corrigir.
    return {
      ok: false,
      codigo: "sem_responsavel",
      motivoParaOperador: `"${tipo.name}" não tem responsável definido, e sem responsável não há agenda para consultar.`,
      motivoParaCliente: `Ainda não há um responsável definido para "${tipo.name}". ${NAO_OFERECA}`,
    };
  }

  const { data: disponibilidade, error: erroDisp } = await supabase
    .from("attendant_availability")
    .select("schedule")
    .eq("organization_id", organizationId)
    .eq("user_id", donoId)
    .maybeSingle();
  if (erroDisp) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: erroDisp.message,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }

  const leitura = lerJornadaDoBanco(disponibilidade?.schedule);
  if (!leitura.ok) {
    // Falha fechada na AÇÃO, aberta na INFORMAÇÃO: schedule corrompido não pode
    // virar lista vazia, senão o dono conclui que está sem vaga e essa conclusão
    // errada não gera chamado nenhum.
    return {
      ok: false,
      codigo: "jornada_mal_configurada",
      // `leitura.motivoParaOperador` já vem como fragmento pensado para
      // encaixar aqui ("ainda não foi configurada. Configure em…" ou "está mal
      // configurada: <motivo>") — ver `lerJornadaDoBanco`. Duas recusas
      // diferentes ("nunca configurou" vs. "configurou errado") não podem virar
      // a mesma frase, senão o operador lê "mal configurada" para um caso que é
      // só "ainda não configurada".
      motivoParaOperador: `A disponibilidade deste responsável ${leitura.motivoParaOperador}`,
      motivoParaCliente: `${leitura.motivoParaCliente} ${NAO_OFERECA}`,
    };
  }

  // ⚠️ As exceções de data são a MESMA régua de `horariosLivres`: coluna `date`
  // no Postgres, sem fuso — o dia LOCAL DA REGRA (`leitura.jornada.timezone`),
  // nunca o dia UTC do instante pedido. Com o dia UTC a coleta começava DEPOIS
  // do dia pedido num fuso negativo: 21:00 de D em America/Sao_Paulo já é
  // 00:00Z de D+1, então a exceção de D (folga, feriado, dia inteiro bloqueado)
  // ficava fora do `.gte()` — e a grade oferecia, e a escrita aceitava, horário
  // de um dia bloqueado (#878).
  //
  // A margem de ±1 dia é a mesma com que `horariosLivres` visita os dias
  // (`diaLocalISO(naoAntesDe - DIA)` … `diaLocalISO(naoDepoisDe + DIA)`): a
  // borda de um dia local pode cair no dia UTC vizinho, e a coleta não fica
  // mais estreita que a visita da grade. Hoje a margem é defesa, não conserto:
  // os horários dos dias da margem já caem fora de `[naoAntesDe, naoDepoisDe]`
  // (sem ela, a suíte fica verde — medido na revisão do lote 10). O que fecha
  // o #878 é buscar pelo dia LOCAL, não a margem.
  const fusoDaRegra = leitura.jornada.timezone;
  const primeiroDiaDaRegra = diaLocalISO(new Date(params.de.getTime() - DIA), fusoDaRegra);
  const ultimoDiaDaRegra = diaLocalISO(new Date(params.ate.getTime() + DIA), fusoDaRegra);

  const [{ data: excecoesRaw, error: erroExc }, oQueOcupa] = await Promise.all([
    supabase
      .from("calendar_availability_exceptions")
      .select("exception_date, is_unavailable, start_minute, end_minute")
      .eq("organization_id", organizationId)
      .eq("user_id", donoId)
      .gte("exception_date", primeiroDiaDaRegra)
      .lte("exception_date", ultimoDiaDaRegra),
    coletaOQueOcupa(supabase, organizationId, {
      donoId,
      de: new Date(params.de.getTime() - Number(tipo.buffer_before_minutes ?? 0) * MINUTO),
      ate: new Date(params.ate.getTime() + Number(tipo.buffer_after_minutes ?? 0) * MINUTO),
      // Remarcar: o compromisso de saída não é ocupação do destino (#1084). A
      // janela alargada acima é justamente o que o fazia parecer um vizinho.
      ignorarAgendamentoId: params.ignorarAgendamentoId,
    }),
  ]);

  if (erroExc) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: erroExc.message,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }
  if (!oQueOcupa.ok) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: oQueOcupa.erro,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }
  const { ocupados, fontesDefasadas } = oQueOcupa;

  // A situação das conexões do dono, para distinguir "não tem Google" de "tem
  // Google que nunca foi lido". Sem `.select` de erro: conexão ilegível cai no
  // mesmo lado de "não sei", que é o lado seguro.
  //
  // Por RPC, e não direto em `calendar_connections`: a RLS da tabela esconde a
  // conexão de um Atendente, e "nunca foi lida" passava a ser "não tem Google"
  // conforme quem perguntava (ver o cabeçalho, issue #879).
  const { data: conexoesRaw } = await supabase.rpc("fn_agenda_conexoes_google_do_dono", {
    p_org: organizationId,
    p_owner: donoId,
  });

  const excecoes: ExcecaoDeData[] = (excecoesRaw ?? []).map((linha) => ({
    // ⚠️ `exception_date` é `date` no Postgres e chega como "YYYY-MM-DD" pelo
    // PostgREST. `diaLocalISO` compara STRING — um `Date` aqui não casaria com
    // dia nenhum, e o bloqueio sumiria em silêncio.
    data: String(linha.exception_date).slice(0, 10),
    indisponivel: linha.is_unavailable,
    inicioMinuto: linha.start_minute,
    fimMinuto: linha.end_minute,
  }));

  const slots = horariosLivres({
    jornada: leitura.jornada,
    excecoes,
    ocupados,
    tipo: {
      duracaoMin: tipo.duration_minutes,
      bufferAntesMin: tipo.buffer_before_minutes,
      bufferDepoisMin: tipo.buffer_after_minutes,
      avisoMinimoMin: tipo.minimum_notice_minutes,
      intervaloMin: tipo.slot_interval_minutes,
      janelaDias: tipo.booking_window_days,
    },
    de: params.de,
    ate: params.ate,
    agora: params.agora,
  });

  let googleCoberturaParcial = true;
  try { googleCoberturaParcial = Boolean(await googleRpc(supabase, "fn_google_coverage", { p_org: organizationId, p_owner: donoId, p_start: params.de.toISOString(), p_end: params.ate.toISOString() })); } catch { /* leitura incerta não afirma cobertura */ }
  return {
    ok: true,
    googleCoberturaParcial,
    slots,
    fusoDaRegra: leitura.jornada.timezone,
    publicouHorarios: leitura.publicouHorarios,
    fusoSuposto: leitura.fusoSuposto,
    fontesDefasadas,
    agendaExternaNuncaLida: agendaExternaNuncaLida(conexoesRaw ?? []),
  };
}


/** Uma linha de `fn_agenda_ocupacao_google_do_dono` — as cinco colunas que a função declara, e só elas. */
interface LinhaDaOcupacaoDoGoogle {
  starts_at: string;
  ends_at: string;
  transparency: string;
  status: string;
  connection_status: string | null;
}

export interface ParametrosDaOcupacao {
  donoId: string;
  de: Date;
  ate: Date;
  /**
   * Um compromisso que NÃO conta: o que está sendo remarcado. Ele ocupa o
   * horário de onde está saindo, e sem isto se veria como conflito ao ser movido
   * para perto de si mesmo.
   */
  ignorarAgendamentoId?: string;
}

/**
 * O QUE OCUPA a agenda de um dono numa janela — a coleta, num lugar só.
 *
 * Agendamentos do CRM e eventos do Google Agenda SELECIONADOS, classificados por
 * `ocupadosDoDono` (que decide status que libera, evento transparente, conexão
 * caída). Nada de jornada, exceção de data, buffer ou aviso mínimo: isso é regra
 * da GRADE, e mora em `horariosLivres`.
 *
 * ⚠️ DOIS LEITORES, UMA COLETA. A grade (`horariosLivresDaOrg`, logo acima) e o
 * encaixe fora da grade (`exigeSemSobreposicao`, no handler de agendamentos)
 * perguntam a mesma coisa — "o que já está tomado?". Quando cada um tinha a sua
 * consulta, o encaixe olhava só `calendar_appointments` e reescrevia à mão a
 * lista de status que liberam: uma pessoa marcava em cima de um compromisso do
 * Google sem aviso nenhum, enquanto a grade escondia aquele mesmo horário.
 *
 * O filtro de janela é o cruzamento ESTRITO (`starts_at < ate` e `ends_at > de`),
 * a mesma régua de `colide`: encostar não é ocupar.
 */
export async function coletaOQueOcupa(
  supabase: SupabaseClient,
  organizationId: string,
  params: ParametrosDaOcupacao,
): Promise<({ ok: true } & OQueOcupa) | { ok: false; erro: string }> {
  let agendamentos = supabase
    .from("calendar_appointments")
    .select("starts_at, ends_at, status")
    .eq("organization_id", organizationId)
    .eq("owner_user_id", params.donoId)
    .lt("starts_at", params.ate.toISOString())
    .gt("ends_at", params.de.toISOString());
  if (params.ignorarAgendamentoId) agendamentos = agendamentos.neq("id", params.ignorarAgendamentoId);

  const [{ data: agendaRaw, error: erroAg }, { data: externosRaw, error: erroExt }] = await Promise.all([
    agendamentos,
    // `calendar_external_events` NÃO tem `user_id`: o dono vem por
    // `connection_id → calendar_connections.user_id`, e a situação da conexão
    // decide se o horário sai com aviso de defasagem.
    //
    // ⚠️ POR RPC, e não pelo embed `calendar_connections!inner`: a RLS da conexão
    // esconde o Google do dono de um Atendente, e a ocupação sumia — da grade E
    // do encaixe, que é por isso que a leitura mora aqui (issue #879, ver o
    // cabeçalho). A função confere o pertencimento e devolve só ocupação.
    supabase.rpc("fn_agenda_ocupacao_google_do_dono", {
      p_org: organizationId,
      p_owner: params.donoId,
      p_de: params.de.toISOString(),
      p_ate: params.ate.toISOString(),
    }),
  ]);

  const erro = erroAg ?? erroExt;
  if (erro) return { ok: false, erro: erro.message };

  return {
    ok: true,
    ...ocupadosDoDono(
      (agendaRaw ?? []) as LinhaDeAgendamento[],
      ((externosRaw ?? []) as LinhaDaOcupacaoDoGoogle[]).map(
        (linha) =>
          ({
            starts_at: linha.starts_at,
            ends_at: linha.ends_at,
            transparency: linha.transparency,
            status: linha.status,
            situacaoDaConexao: linha.connection_status ?? "error",
          }) satisfies LinhaDeEventoExterno,
      ),
    ),
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// A LISTAGEM — "o que este cliente tem marcado?" e "como está o dia da equipe?"
//
// Mesma razão de existir da coleta acima: a IA lista compromissos pela conversa e
// a tela lista pelo painel. Duas leituras dariam respostas diferentes sobre o mesmo
// dia — e aqui o erro é pior que na consulta de horário livre, porque listar é o
// que o agente faz ANTES de dizer ao cliente "você já tem consulta marcada".
//
// ⚠️ O VÍNCULO COM O LEAD É POLIMÓRFICO (DECISÃO 6): não há `lead_id` em
// `calendar_appointments` — o ponteiro é `crm_lead_links` com
// `target_kind='appointment'`. Filtrar por lead custa uma consulta a mais, e é o
// preço de não ter duplicado a FK.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgendamentoListado {
  meetingState?: string;
  meetingUrl?: string | null;
  revision?:number;
  id: string;
  titulo: string;
  iniciaEm: string;
  terminaEm: string;
  fuso: string;
  situacao: string;
  donoId: string | null;
  contatoId: string | null;
  contatoNome: string | null;
  /**
   * O TIPO DE ATENDIMENTO de que o compromisso nasceu (`calendar_event_types`).
   *
   * `null` quando a linha não tem tipo — bloqueio do Google e compromisso
   * marcado antes do cadastro do tipo. Inventar um aqui faria um calendário
   * externo mostrar "Consulta" para um bloco que ninguém marcou. (issue #1744)
   */
  tipo?: { slug: string; nome: string } | null;
  /**
   * COMO e ONDE se atende — o mesmo par `location_kind`/`location_details` que
   * `lib/agenda/locais.ts` rotula na tela. Entrego os VALORES, não o rótulo:
   * quem lê é um integrante externo que tem o próprio vocabulário, e o rótulo
   * em português seria uma tradução a menos para ele. (issue #1744)
   */
  local?: { tipo: string | null; descricao: string | null };
  /**
   * Negócios do funil vinculados a este compromisso (`crm_lead_links`,
   * `target_kind='appointment'` — DECISÃO 6: não há `lead_id` na linha).
   *
   * Custa uma consulta extra, então é OPÇÃO: a grade da tela não publica o
   * vínculo e não paga o preço de quem publica. (issue #1744)
   */
  leadIds?: string[];
}

export interface ParametrosDaLista {
  contactId?: string | null;
  /** Resolvido por `crm_lead_links` — ver o aviso acima. */
  leadId?: string | null;
  /**
   * `YYYY-MM-DD`; filtra o dia inteiro.
   *
   * ⚠️ O CORTE É EM UTC, e para fuso negativo isso NÃO é o dia do usuário.
   * Medido para `America/Sao_Paulo`, dia 12: o filtro pega de 11/03 21:00 até
   * 12/03 20:59 na parede de quem olha — três horas do dia ANTERIOR entram, e as
   * três últimas do dia pedido ficam de fora. Um compromisso das 22h some da
   * lista do próprio dia.
   *
   * Quem precisa de recorte exato usa `de`/`ate`, que são INSTANTES e não têm
   * ambiguidade. `dia` fica para quem só quer um recorte grosseiro — e agora
   * sabe o que está pedindo.
   */
  dia?: string | null;
  /**
   * Recorte por PERÍODO, em instantes ISO. É o que a grade da tela usa: ela é
   * semanal e mensal (`startOfWeek`, seis semanas no mês), então `dia` não a
   * serve — e sete requisições para desenhar uma semana seria a alternativa.
   *
   * Instante em vez de data resolve o fuso na origem: quem chama calcula os
   * limites no fuso de APRESENTAÇÃO e manda o instante, sem esta função
   * precisar adivinhar em que fuso o "dia" foi pedido.
   */
  de?: string | null;
  ate?: string | null;
  ownerUserId?: string | null;
  situacao?: SituacaoDoAgendamento | null;
  /**
   * Cursor opaco devolvido em `proximo` — retoma DEPOIS do último item da
   * página anterior, pelo par `(starts_at, id)`. Um UUID não bastaria: dois
   * compromissos no mesmo minuto têm o mesmo `starts_at`, e só o id desempata.
   * (issue #1744)
   */
  depoisDe?: string | null;
  /**
   * Traz `leadIds`. Custa uma consulta extra por página, então só quem publica
   * o vínculo liga isto — a grade da tela continua sem pagar por ele.
   */
  comLeadIds?: boolean;
  limite: number;
}

export type ResultadoDaLista =
  | {
      ok: true;
      agendamentos: AgendamentoListado[];
      /**
       * Cursor para a PRÓXIMA página — `null` quando não sobrou nada além do
       * `limite`. É o que um calendário externo repassa no `depois_de` para
       * seguir lendo sem repetir item nem pular nenhum. (issue #1744)
       */
      proximo?: string | null;
    }
  | {
      ok: false;
      // `alvo_nao_e_lead`: o id veio no parâmetro `lead_id` e não é um negócio
      // do funil — quase sempre um id de CONTATO, que é o que o contexto do
      // turno chama de `lead_id`. Ver o ramo que o emite. (issue #509)
      //
      // `janela_invalida` e `cursor_invalido` são erro de QUEM CHAMA, como os
      // dois de cima: a janela passou do teto, veio invertida ou incompleta, ou
      // o cursor não é um que esta função emitiu. (issue #1744)
      codigo: "erro_interno" | "sem_alvo" | "alvo_nao_e_lead" | "janela_invalida" | "cursor_invalido";
      motivoParaOperador: string;
      motivoParaCliente: string;
    };

/**
 * O embed do PostgREST vem objeto ou array conforme o gerador de tipos; aceite
 * os dois. A DECISÃO de como a pessoa se chama não mora aqui: era uma segunda
 * função com o nome `nomeDoContato`, cadeia remontada à mão e sem a guarda de
 * identificador técnico — ela devolvia `Contato 543134@lid` onde a central
 * devolve `null`, e esse valor ia para a fala do agente sobre o compromisso.
 */
function contatoDoEmbed(
  c: ContatoNomeavel | ContatoNomeavel[] | null | undefined,
): string | null {
  return nomeDoContato(Array.isArray(c) ? (c[0] ?? null) : c);
}

// ─────────────────────────────────────────────────────────────────────────────
// O CURSOR DA LISTAGEM (issue #1744)
//
// `depois_de` é o par `(starts_at, id)` do ÚLTIMO item da página anterior, e é
// opaco de propósito: o formato é interno, e trocá-lo um dia não pode quebrar
// quem já guardou um cursor. base64url de JSON é o mesmo desenho do cursor de
// `listLeadsHandler` (`app/api/v1/leads/_handler.ts`) — duas formas diferentes
// para a mesma ideia seria a terceira lista da qual o repo avisa.
//
// O `id` não é enfeite: a ordenação é por `starts_at` e dois compromissos no
// mesmo minuto empatam. Sem o desempate, a página seguinte recomeçaria do
// primeiro dos empatados e o integrante leria o mesmo item duas vezes.
// ─────────────────────────────────────────────────────────────────────────────
export interface CursorDaLista {
  inicio: string;
  id: string;
}

export function codificarCursorDaLista(c: CursorDaLista): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodificarCursorDaLista(bruto: string): CursorDaLista | null {
  try {
    const c = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Partial<CursorDaLista>;
    if (typeof c.inicio !== "string" || typeof c.id !== "string") return null;
    if (Number.isNaN(new Date(c.inicio).getTime())) return null;
    return { inicio: c.inicio, id: c.id };
  } catch {
    return null;
  }
}

/**
 * O fuso da organização (`organizations.timezone`) — o que decide qual é o
 * "dia 12" para quem olha a agenda.
 *
 * `null` é a resposta de quem NÃO SABE, e é sempre seguro: sem fuso, `dia`
 * continua cortando em UTC como sempre cortou (comportamento antigo, não um
 * palpite). Falha de leitura e fuso ausente caem no mesmo ramo de propósito —
 * um `dia` errado por fuso desconhecido é ruim, um `dia` errado por engano é
 * pior, e o integrante que precisa de recorte exato tem `de`/`ate`.
 */
async function fusoDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) return null;
    const tz = (data as { timezone?: unknown } | null)?.timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

/**
 * O intervalo UTC de um dia CIVIL no fuso dado — `[início do dia, início do
 * próximo dia)`.
 *
 * O segundo limite é o início do dia SEGUINTE calculado no MESMO fuso, e não
 * `início + 24h`: no dia do horário de verão o dia tem 23 ou 25 horas, e somar
 * 24 à fecharia uma hora cedo ou deixaria uma hora a mais na lista.
 *
 * `null` quando o fuso é inexistente (`instanteDe` lança `RangeError`) — quem
 * chama cai no corte em UTC.
 */
function janelaDoDiaNoFuso(dia: string, fuso: string): { de: string; ate: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return null;
  const [ano, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // O dia seguinte no calendário GREGORIANO (e não `+ 86400000`), para que a
  // virada de mês e de ano se resolva sozinhas antes de virar parede.
  const seguinte = new Date(Date.UTC(ano, mes - 1, d + 1));
  try {
    const de = instanteDe({ ano, mes, dia: d }, fuso);
    const ate = instanteDe(
      {
        ano: seguinte.getUTCFullYear(),
        mes: seguinte.getUTCMonth() + 1,
        dia: seguinte.getUTCDate(),
      },
      fuso,
    );
    if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) return null;
    return { de: de.toISOString(), ate: ate.toISOString() };
  } catch {
    return null;
  }
}

export async function listaAgendamentos(
  supabase: SupabaseClient,
  organizationId: string,
  params: ParametrosDaLista,
): Promise<ResultadoDaLista> {
  // ─── A JANELA, ANTES DE QUALQUER COISA (issue #1744) ──────────────────────
  //
  // `de`/`ate` são INSTANTES e dispensam qualquer outro recorte: com os dois, a
  // listagem da organização inteira é permitida (é o `temAlvo` de baixo). Mas
  // a janela é também o único caminho que varre semanas de uma vez, então ela é
  // a única que pode virar uma varredura de ano inteiro por erro de chamada —
  // por isso o teto é checado AQUI, e não em cada porta: rota e ferramenta MCP
  // chamam esta mesma função, e uma régua por fora daria duas respostas.
  const veioPeriodo = params.de !== undefined && params.de !== null
    || params.ate !== undefined && params.ate !== null;
  if (veioPeriodo) {
    const de = params.de ? new Date(params.de) : null;
    const ate = params.ate ? new Date(params.ate) : null;
    const inteiro = (d: Date | null): d is Date => d !== null && !Number.isNaN(d.getTime());
    if (!inteiro(de) || !inteiro(ate)) {
      return {
        ok: false,
        codigo: "janela_invalida",
        motivoParaOperador:
          "período incompleto ou inválido: `de` e `ate` vêm JUNTOS, como instantes ISO " +
          "(ex.: 2026-09-01T00:00:00Z).",
        motivoParaCliente:
          "Preciso do início e do fim do período. Pergunte qual intervalo a pessoa quer ver e " +
          "mande os dois, com data e hora.",
      };
    }
    if (ate.getTime() <= de.getTime()) {
      return {
        ok: false,
        codigo: "janela_invalida",
        motivoParaOperador: "`ate` é anterior (ou igual) a `de`: o período tem de ir do início para o fim.",
        motivoParaCliente:
          "O fim do período ficou antes do começo. Pergunte de novo qual intervalo a pessoa quer ver.",
      };
    }
    if (ate.getTime() - de.getTime() > MAXIMO_DE_DIAS * 86_400_000) {
      return {
        ok: false,
        codigo: "janela_invalida",
        motivoParaOperador:
          `o período pedido passa de ${MAXIMO_DE_DIAS} dias. Pergunte um intervalo menor — ` +
          "uma semana por chamada é o que um calendário desenha.",
        motivoParaCliente:
          `Esse intervalo é grande demais para uma consulta só. Divida em partes de até ` +
          `${MAXIMO_DE_DIAS} dias e leia uma por vez.`,
      };
    }
  }

  const temAlvo = Boolean(
    params.contactId || params.leadId || params.dia || params.ownerUserId || (params.de && params.ate),
  );
  if (!temAlvo) {
    // Sem recorte, isto varreria a agenda inteira da organização. Recusa com ensino,
    // não lista vazia: vazio faria o modelo concluir que não há nada marcado.
    return {
      ok: false,
      codigo: "sem_alvo",
      motivoParaOperador:
        "listagem sem recorte: informe contato, lead, dia, período (de+ate) ou responsável.",
      motivoParaCliente:
        "Preciso saber de quem ou de que dia. Pergunte de qual cliente ou de qual data você quer ver os compromissos.",
    };
  }

  let idsPorLead: string[] | null = null;
  if (params.leadId) {
    // DECISÃO 6: o vínculo é polimórfico. `target_kind='appointment'` já está no CHECK
    // de `crm_lead_links` desde antes desta entrega.
    const { data, error } = await supabase
      .from("crm_lead_links")
      .select("target_id")
      .eq("organization_id", organizationId)
      .eq("lead_id", params.leadId)
      .eq("target_kind", "appointment");
    if (error) {
      return {
        ok: false,
        codigo: "erro_interno",
        motivoParaOperador: error.message,
        motivoParaCliente: "Não consegui consultar os compromissos agora. Avise que alguém da equipe confirma.",
      };
    }
    idsPorLead = (data ?? []).map((l) => String(l.target_id));
    if (idsPorLead.length === 0) {
      // ⚠️ SEM VÍNCULO, HÁ DUAS HISTÓRIAS DIFERENTES — e só uma delas pode ser
      // contada ao cliente.
      //
      // "Este negócio não tem nada marcado" é resposta CERTA, e o comentário
      // que estava aqui defendia isso com razão. Mas ela era dada TAMBÉM quando
      // o id nem é um lead — e no motor `leadId` É o `contact_id`
      // (`inbound-turn.ts:1121`, `get-lead-context.ts:193`), enquanto o campo
      // publicado no contexto do turno se chama `lead_id`. O modelo passava o
      // id do contato para cá, a busca por vínculo não achava nada, e o agente
      // NEGAVA ao cliente um compromisso que ele mesmo tinha acabado de marcar.
      //
      // Nada reclamava: consulta válida, lista vazia é legítima, e o modelo não
      // tinha como suspeitar. A consulta abaixo separa as duas histórias, e só
      // roda no ramo que já ia devolver vazio. (issue #509)
      const { data: ehLead } = await supabase
        .from("crm_leads")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", params.leadId)
        .maybeSingle();

      if (!ehLead) {
        return {
          ok: false,
          codigo: "alvo_nao_e_lead",
          motivoParaOperador:
            `o id ${params.leadId} não é um negócio do funil. No contexto do turno, o campo ` +
            "`lead_id` carrega o id do CONTATO — para consultar os compromissos de uma pessoa, " +
            "use `contact_id`.",
          motivoParaCliente:
            "Não consegui confirmar a agenda dessa pessoa agora. NÃO diga que ela não tem nada " +
            "marcado — diga que vai confirmar com a equipe.",
        };
      }
      // Lead de verdade, sem nenhum vínculo: "nada marcado" é a resposta certa.
      return { ok: true, agendamentos: [] };
    }
  }

  // O `+ 1` é o truque do `has_more` de sempre: vendo uma linha a mais do que
  // o `limite` eu sei que sobrou página, sem contar tudo. A folga é cortada na
  // montagem da resposta, então quem chama continua recebendo no máximo `limite`.
  let q = supabase
    .from("calendar_appointments")
    .select(
      "id, title, starts_at, ends_at, time_zone, status, revision, meeting_state, meeting_url, owner_user_id, contact_id, location_kind, location_details, calendar_event_types(id, name, slug), contacts(name, display_name)",
    )
    .eq("organization_id", organizationId)
    .order("starts_at", { ascending: true })
    // O DESEMPATE por `id` é o que faz o cursor ser determinístico: sem ele,
    // dois compromissos no mesmo instante trocam de lugar entre uma página e
    // outra e a paginação pula ou repete item. (issue #1744)
    .order("id", { ascending: true })
    .limit(params.limite + 1);

  if (idsPorLead) q = q.in("id", idsPorLead);
  if (params.contactId) q = q.eq("contact_id", params.contactId);
  if (params.ownerUserId) q = q.eq("owner_user_id", params.ownerUserId);
  if (params.situacao) q = q.eq("status", params.situacao);
  if (params.depoisDe) {
    const cursor = decodificarCursorDaLista(params.depoisDe);
    if (!cursor) {
      return {
        ok: false,
        codigo: "cursor_invalido",
        motivoParaOperador:
          "`depois_de` não é um cursor que esta listagem emitiu. Passe `proximo` exatamente como veio, " +
          "ou comece a leitura sem cursor.",
        motivoParaCliente:
          "A leitura parou no meio e eu não consegui continuar de onde parei. Comece de novo do início.",
      };
    }
    q = q.or(
      `starts_at.gt.${cursor.inicio},and(starts_at.eq.${cursor.inicio},id.gt.${cursor.id})`,
    );
  }
  if (params.dia && !(params.de && params.ate)) {
    // ─── O DIA É DA ORGANIZAÇÃO, E NÃO DE UTC (issue #1744) ────────────────
    //
    // O corte em UTC estava escrito no próprio código: em São Paulo três horas
    // do dia ANTERIOR entravam e as três últimas do dia pedido ficavam de fora
    // — um compromisso das 22h sumia da lista do próprio dia. Agora o `dia` é
    // um dia CIVIL no `organizations.timezone`, e o filtro é o intervalo UTC
    // equivalente.
    //
    // Sem fuso legível (coluna vazia, fuso inválido, client que não lê a org)
    // o comportamento É o antigo, em UTC — degradar para o que existia é
    // melhor do que adivinhar, e `de`/`ate` continua sendo o recorte exato.
    const fuso = await fusoDaOrganizacao(supabase, organizationId);
    const janela = fuso ? janelaDoDiaNoFuso(params.dia, fuso) : null;
    if (janela) {
      q = q.gte("starts_at", janela.de).lt("starts_at", janela.ate);
    } else {
      q = q.gte("starts_at", `${params.dia}T00:00:00Z`).lt("starts_at", `${params.dia}T23:59:59.999Z`);
    }
  }
  // O período vence o dia quando os dois vêm: quem manda instante está pedindo
  // recorte exato, e sobrepor o corte grosseiro do `dia` devolveria a interseção
  // — que não é o que nenhum dos dois pediu.
  if (params.de && params.ate) {
    q = q.gte("starts_at", params.de).lt("starts_at", params.ate);
  } else if (!params.dia) {
    // ⚠️ SEM RECORTE DE TEMPO, O PISO É AGORA — e sem este `else if` a listagem
    // respondia a pergunta errada.
    //
    // A query ordena `ascending` e corta em `limite`. Sem piso, um contato com
    // mais compromissos que o limite recebia os MAIS ANTIGOS, e o de amanhã
    // ficava de fora. Medido no caminho real: 60 linhas no banco, limite 20, e a
    // consulta recém-marcada não aparecia na listagem do próprio contato.
    //
    // E é a pergunta que a ferramenta MCP declara responder: "USE ANTES DE
    // MARCAR: cliente que já tem consulta marcada não deve receber oferta de
    // horário como se não tivesse". Consulta do ano passado não responde isso.
    // A combinação limite + ordem derrotava a instrução que a própria ferramenta
    // dá ao modelo.
    //
    // Quem quiser o passado pede explicitamente por `de`/`ate` ou por `dia` —
    // os dois caminhos continuam intactos.
    q = q.gte("starts_at", new Date().toISOString());
  }

  const { data, error } = await q;
  if (error) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: error.message,
      motivoParaCliente: "Não consegui consultar os compromissos agora. Avise que alguém da equipe confirma.",
    };
  }

  const linhas = data ?? [];
  const temMais = linhas.length > params.limite;
  const pagina = temMais ? linhas.slice(0, params.limite) : linhas;
  const ultima = pagina[pagina.length - 1];

  // O vínculo com o negócio é uma segunda tabela (DECISÃO 6), então é uma
  // segunda consulta — paga só por quem pediu, e nunca quando a página veio
  // vazia (uma consulta contra `in ()` não diria nada).
  let vinculosPorAlvo: Map<string, string[]> | null = null;
  if (params.comLeadIds && pagina.length > 0) {
    const { data: vinculos, error: erroVinculos } = await supabase
      .from("crm_lead_links")
      .select("lead_id, target_id")
      .eq("organization_id", organizationId)
      .eq("target_kind", "appointment")
      .in("target_id", pagina.map((l) => String(l.id)));
    if (erroVinculos) {
      // Vínculo é cortesia: a listagem não pode morrer por ele. Sem mapa, os
      // itens saem com `leadIds` vazio — que é o que a tela da grade já mostra.
      vinculosPorAlvo = null;
    } else {
      vinculosPorAlvo = new Map();
      for (const v of vinculos ?? []) {
        const alvo = String((v as { target_id: unknown }).target_id);
        const lead = String((v as { lead_id: unknown }).lead_id);
        const lista = vinculosPorAlvo.get(alvo) ?? [];
        lista.push(lead);
        vinculosPorAlvo.set(alvo, lista);
      }
    }
  }

  return {
    ok: true,
    agendamentos: pagina.map((l) => {
      // O embed chega objeto ou array conforme o gerador de tipos — o mesmo
      // aviso de `contatoDoEmbed`, aqui de novo porque é o MESMO embed.
      const tipo = (Array.isArray(l.calendar_event_types)
        ? (l.calendar_event_types[0] ?? null)
        : (l.calendar_event_types ?? null)) as { name?: unknown; slug?: unknown } | null;
      const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
      return {
        id: String(l.id),
        titulo: String(l.title),
        meetingState: l.meeting_state,
        meetingUrl: l.meeting_state === "ready" ? l.meeting_url : null,
        revision:Number(l.revision),
        iniciaEm: String(l.starts_at),
        terminaEm: String(l.ends_at),
        fuso: String(l.time_zone),
        situacao: String(l.status),
        donoId: l.owner_user_id ? String(l.owner_user_id) : null,
        contatoId: l.contact_id ? String(l.contact_id) : null,
        // O ID sozinho não serve a nenhum dos dois consumidores: a grade precisa do
        // nome para dizer "com quem", e o AGENTE recebia um uuid cru onde devia
        // dizer "você já tem consulta marcada, Maria". Mesma coluna que a tela do
        // produto lê, e a MESMA decisão de nome — `lib/contacts/rotulo-do-contato.ts`,
        // não um precedente copiado de outro arquivo.
        contatoNome: contatoDoEmbed(l.contacts),
        tipo: tipo ? { slug: texto(tipo.slug) ?? "", nome: texto(tipo.name) ?? "" } : null,
        local: { tipo: texto(l.location_kind), descricao: texto(l.location_details) },
        leadIds: vinculosPorAlvo?.get(String(l.id)) ?? [],
      } satisfies AgendamentoListado;
    }),
    proximo:
      temMais && ultima
        ? codificarCursorDaLista({ inicio: String(ultima.starts_at), id: String(ultima.id) })
        : null,
  };
}


/**
 * O id do tipo a partir do SLUG — a ponte entre o que o modelo sabe e o que o
 * handler pede.
 *
 * `MarcarInput.event_type_id` é uuid, e o modelo não tem uuid: o slug existe
 * justamente para "dar à IA um handle que ela não alucina". A tradução acontece
 * aqui, uma vez, em vez de cada tool inventar a sua.
 */
export async function idDoTipoPorSlug(
  supabase: SupabaseClient,
  organizationId: string,
  slug: string,
): Promise<{ id: string; nome: string } | null> {
  const { data } = await supabase
    .from("calendar_event_types")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle();
  return data ? { id: String(data.id), nome: String(data.name) } : null;
}


/**
 * O que uma organização OFERECE para marcar.
 *
 * ⚠️ ESTE COLETOR NASCEU DE QUATRO CÓPIAS. `calendar_event_types` era lida em
 * quatro lugares independentes, cada um com o seu recorte de colunas: o `GET`
 * de `/api/v1/agenda/tipos`, a tela de configuração, a tela que marca e o
 * `marcarAgendamentoHandler`. Nenhuma chamava a outra. É a mesma situação que
 * o cabeçalho deste arquivo descreve para os horários — e o desfecho seria o
 * mesmo: a tela e a IA respondendo por regras diferentes sobre o que a clínica
 * atende.
 *
 * ⚠️ `incluirInativos` NÃO é conveniência, é a diferença entre duas perguntas.
 * *"O que existe de cadastro?"* (tela de configuração, que precisa mostrar o
 * desativado para alguém poder reativá-lo) e *"o que dá para marcar agora?"*
 * (a IA e a tela que marca). Oferecer um tipo inativo ao modelo é beco sem
 * saída garantido: `horariosLivresDaOrg` o encontra e recusa com
 * `tipo_desativado`. Por isso o default é SÓ ATIVOS — quem quer o outro pede.
 */
export interface TipoDeAtendimento {
  /** Chave de lista e alvo de PATCH/DELETE na TELA. Nunca vai ao modelo (ver a tool). */
  id: string;
  nome: string;
  /** O handle estável que as ferramentas de agenda aceitam em `event_type_slug`. */
  slug: string;
  descricao: string | null;
  categoria: string;
  duracaoMin: number;
  localKind: string;
  localDetalhes: string | null;
  /** true = o compromisso nasce aguardando o cliente confirmar (`pending`). */
  precisaConfirmacao: boolean;
  ativo: boolean;
  /** Sem dono não há jornada, e sem jornada não há horário (`sem_responsavel`). */
  donoPadraoId: string | null;
  /**
   * Os quatro números da grade. Eles NÃO vão ao modelo — `horariosLivresDaOrg`
   * já os aplicou antes de devolver os horários, e repassá-los convidaria a IA a
   * recalcular o que a máquina calculou. Estão aqui porque a rota de
   * configuração os publica desde antes deste coletor existir, e campo que some
   * de uma rota `/api/v1/` é quebra de contrato.
   */
  bufferAntesMin: number;
  bufferDepoisMin: number;
  antecedenciaMinimaMin: number;
  janelaDeAgendamentoDias: number;
  /**
   * O LEMBRETE deste tipo — o que o cron `agenda-reminder` lê para decidir se
   * manda mensagem, e quantos minutos antes.
   *
   * Também NÃO vão ao modelo, e pelo mesmo motivo dos quatro acima: a IA não
   * dispara lembrete nem tem o que fazer com a antecedência dele. Estão aqui
   * porque quem administra o cadastro precisa LER o estado antes de mudá-lo —
   * uma tela que só sabe pedir "ligue" e nunca sabe se está ligado é o mesmo
   * controle decorativo, invertido.
   */
  lembreteLigado: boolean;
  lembreteAntecedenciaMin: number;
  /** Degraus ADICIONAIS, somados ao principal. Vazio = um lembrete só. */
  lembreteDegrausExtras: number[];
  /** Texto próprio do lembrete principal. null = a frase padrão do cron. */
  lembreteMensagem: string | null;
  /** Texto de cada extra, chave = minutos antes. Vazio = nenhum extra tem texto próprio. */
  lembreteMensagens: Record<string, string>;
  /** Preço padrão em centavos, ou null quando o negócio digita na hora. */
  precoPadraoCents: number | null;
}

export type ResultadoDosTipos =
  | { ok: true; tipos: TipoDeAtendimento[] }
  | {
      ok: false;
      codigo: "erro_interno";
      motivoParaOperador: string;
      motivoParaCliente: string;
    };

/**
 * Os tipos de atendimento da organização.
 *
 * ⚠️ Erro de leitura NUNCA vira lista vazia. As duas leituras são
 * indistinguíveis para quem recebe, e significam o oposto: lista vazia diz "a
 * organização não cadastrou nada" e faria o modelo anunciar ao paciente que a
 * clínica não atende. A recusa nomeada é o que leva alguém a corrigir.
 */
export async function listaTiposDeAtendimento(
  supabase: SupabaseClient,
  organizationId: string,
  opcoes?: { incluirInativos?: boolean },
): Promise<ResultadoDosTipos> {
  const incluirInativos = opcoes?.incluirInativos ?? false;

  let q = supabase
    .from("calendar_event_types")
    .select(
      "id, name, slug, description, category, duration_minutes, location_kind, location_details, requires_confirmation, is_active, default_owner_user_id, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days, reminder_enabled, reminder_minutes_before, reminder_extra_offsets_minutes, reminder_body, reminder_bodies, default_price_cents",
    )
    // Service role bypassa a RLS: este filtro é a única proteção no caminho da
    // ferramenta MCP (ver o cabeçalho do arquivo).
    .eq("organization_id", organizationId);
  if (!incluirInativos) q = q.eq("is_active", true);

  const { data, error } = await q.order("is_active", { ascending: false }).order("name");

  if (error) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: error.message,
      motivoParaCliente: `Não consegui ver o que a agenda oferece agora. ${NAO_OFERECA}`,
    };
  }

  return {
    ok: true,
    tipos: (data ?? []).map((t) => ({
      id: String(t.id),
      nome: String(t.name),
      slug: String(t.slug),
      descricao: t.description === null ? null : String(t.description),
      categoria: String(t.category),
      duracaoMin: Number(t.duration_minutes),
      localKind: String(t.location_kind),
      localDetalhes: t.location_details === null ? null : String(t.location_details),
      precisaConfirmacao: Boolean(t.requires_confirmation),
      ativo: Boolean(t.is_active),
      donoPadraoId: t.default_owner_user_id === null ? null : String(t.default_owner_user_id),
      bufferAntesMin: Number(t.buffer_before_minutes),
      bufferDepoisMin: Number(t.buffer_after_minutes),
      antecedenciaMinimaMin: Number(t.minimum_notice_minutes),
      janelaDeAgendamentoDias: Number(t.booking_window_days),
      lembreteLigado: Boolean(t.reminder_enabled),
      lembreteAntecedenciaMin: Number(t.reminder_minutes_before),
      lembreteDegrausExtras: Array.isArray(t.reminder_extra_offsets_minutes)
        ? t.reminder_extra_offsets_minutes.map(Number)
        : [],
      lembreteMensagem: t.reminder_body === null || t.reminder_body === undefined
        ? null
        : String(t.reminder_body),
      lembreteMensagens: lerCorposDoLembrete(t.reminder_bodies),
      precoPadraoCents:
        t.default_price_cents === null || t.default_price_cents === undefined
          ? null
          : Number(t.default_price_cents),
    })),
  };
}
