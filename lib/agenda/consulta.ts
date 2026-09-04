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
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { horariosLivres, type ExcecaoDeData, type Slot } from "./horarios-livres";
import { lerJornadaDoBanco } from "./jornada";
import {
  agendaExternaNuncaLida,
  ocupadosDoDono,
  type LinhaDeAgendamento,
  type LinhaDeEventoExterno,
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
    }
  | {
      ok: false;
      codigo: CodigoDeRecusaDaConsulta;
      /** Nomeia campo e pessoa. Plateia: quem configura. */
      motivoParaOperador: string;
      /** Sem nome de campo, e diz o que fazer. Plateia: o modelo, e por tabela o cliente. */
      motivoParaCliente: string;
    };

/** `YYYY-MM-DD` de um instante, em UTC — a régua que a coluna `date` usa. */
function diaISO(instante: Date): string {
  return instante.toISOString().slice(0, 10);
}

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

  const [{ data: excecoesRaw, error: erroExc }, { data: agendaRaw, error: erroAg }] =
    await Promise.all([
      supabase
        .from("calendar_availability_exceptions")
        .select("exception_date, is_unavailable, start_minute, end_minute")
        .eq("organization_id", organizationId)
        .eq("user_id", donoId)
        .gte("exception_date", diaISO(params.de))
        .lte("exception_date", diaISO(params.ate)),
      supabase
        .from("calendar_appointments")
        .select("starts_at, ends_at, status")
        .eq("organization_id", organizationId)
        .eq("owner_user_id", donoId)
        .lt("starts_at", params.ate.toISOString())
        .gt("ends_at", params.de.toISOString()),
    ]);

  const erroDeColeta = erroExc ?? erroAg;
  if (erroDeColeta) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: erroDeColeta.message,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }

  // `calendar_external_events` NÃO tem `user_id`: o dono vem por
  // `connection_id → calendar_connections.user_id`. O join traz de carona a
  // situação da conexão, que decide se o horário sai com aviso de defasagem.
  // A situação das conexões do dono, para distinguir "não tem Google" de "tem
  // Google que nunca foi lido". Sem `.select` de erro: conexão ilegível cai no
  // mesmo lado de "não sei", que é o lado seguro.
  const { data: conexoesRaw } = await supabase
    .from("calendar_connections")
    .select("status, last_sync_at")
    .eq("organization_id", organizationId)
    .eq("user_id", donoId);

  const { data: externosRaw, error: erroExt } = await supabase
    .from("calendar_external_events")
    .select("starts_at, ends_at, transparency, status, calendar_connections!inner(user_id, status)")
    .eq("organization_id", organizationId)
    .eq("calendar_connections.user_id", donoId)
    .lt("starts_at", params.ate.toISOString())
    .gt("ends_at", params.de.toISOString());
  if (erroExt) {
    return {
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: erroExt.message,
      motivoParaCliente: `Não consegui consultar a agenda agora. ${NAO_OFERECA}`,
    };
  }

  const excecoes: ExcecaoDeData[] = (excecoesRaw ?? []).map((linha) => ({
    // ⚠️ `exception_date` é `date` no Postgres e chega como "YYYY-MM-DD" pelo
    // PostgREST. `diaLocalISO` compara STRING — um `Date` aqui não casaria com
    // dia nenhum, e o bloqueio sumiria em silêncio.
    data: String(linha.exception_date).slice(0, 10),
    indisponivel: linha.is_unavailable,
    inicioMinuto: linha.start_minute,
    fimMinuto: linha.end_minute,
  }));

  const { ocupados, fontesDefasadas } = ocupadosDoDono(
    (agendaRaw ?? []) as LinhaDeAgendamento[],
    (externosRaw ?? []).map((linha) => {
      const conexao = linha.calendar_connections as unknown as { status?: string } | null;
      return {
        starts_at: linha.starts_at,
        ends_at: linha.ends_at,
        transparency: linha.transparency,
        status: linha.status,
        situacaoDaConexao: conexao?.status ?? "error",
      } satisfies LinhaDeEventoExterno;
    }),
  );

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

  return {
    ok: true,
    slots,
    fusoDaRegra: leitura.jornada.timezone,
    publicouHorarios: leitura.publicouHorarios,
    fusoSuposto: leitura.fusoSuposto,
    fontesDefasadas,
    agendaExternaNuncaLida: agendaExternaNuncaLida(conexoesRaw ?? []),
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
  id: string;
  titulo: string;
  iniciaEm: string;
  terminaEm: string;
  fuso: string;
  situacao: string;
  donoId: string | null;
  contatoId: string | null;
  contatoNome: string | null;
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
  limite: number;
}

export type ResultadoDaLista =
  | { ok: true; agendamentos: AgendamentoListado[] }
  | {
      ok: false;
      // `alvo_nao_e_lead`: o id veio no parâmetro `lead_id` e não é um negócio
      // do funil — quase sempre um id de CONTATO, que é o que o contexto do
      // turno chama de `lead_id`. Ver o ramo que o emite. (issue #509)
      codigo: "erro_interno" | "sem_alvo" | "alvo_nao_e_lead";
      motivoParaOperador: string;
      motivoParaCliente: string;
    };

/** O embed do PostgREST vem objeto ou array conforme o gerador de tipos; aceite os dois. */
function nomeDoContato(
  c: { name: string | null; display_name: string | null } | { name: string | null; display_name: string | null }[] | null | undefined,
): string | null {
  const alvo = Array.isArray(c) ? c[0] : c;
  return alvo?.name ?? alvo?.display_name ?? null;
}

export async function listaAgendamentos(
  supabase: SupabaseClient,
  organizationId: string,
  params: ParametrosDaLista,
): Promise<ResultadoDaLista> {
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

  let q = supabase
    .from("calendar_appointments")
    .select(
      "id, title, starts_at, ends_at, time_zone, status, owner_user_id, contact_id, contacts(name, display_name)",
    )
    .eq("organization_id", organizationId)
    .order("starts_at", { ascending: true })
    .limit(params.limite);

  if (idsPorLead) q = q.in("id", idsPorLead);
  if (params.contactId) q = q.eq("contact_id", params.contactId);
  if (params.ownerUserId) q = q.eq("owner_user_id", params.ownerUserId);
  if (params.situacao) q = q.eq("status", params.situacao);
  if (params.dia) {
    q = q.gte("starts_at", `${params.dia}T00:00:00Z`).lt("starts_at", `${params.dia}T23:59:59.999Z`);
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

  return {
    ok: true,
    agendamentos: (data ?? []).map((l) => ({
      id: String(l.id),
      titulo: String(l.title),
      iniciaEm: String(l.starts_at),
      terminaEm: String(l.ends_at),
      fuso: String(l.time_zone),
      situacao: String(l.status),
      donoId: l.owner_user_id ? String(l.owner_user_id) : null,
      contatoId: l.contact_id ? String(l.contact_id) : null,
      // O ID sozinho não serve a nenhum dos dois consumidores: a grade precisa do
      // nome para dizer "com quem", e o AGENTE recebia um uuid cru onde devia
      // dizer "você já tem consulta marcada, Maria". Mesma coluna que a tela do
      // produto lê, mesmo precedente de `name` antes de `display_name`.
      contatoNome: nomeDoContato(l.contacts),
    })),
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
      "id, name, slug, description, category, duration_minutes, location_kind, location_details, requires_confirmation, is_active, default_owner_user_id, buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_window_days",
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
    })),
  };
}
