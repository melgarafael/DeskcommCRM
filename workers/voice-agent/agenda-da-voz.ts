/**
 * workers/voice-agent/agenda-da-voz.ts
 *
 * A AGENDA DENTRO DA LIGAÇÃO — o que o agente de voz pode fazer com ela.
 *
 * O agente de TEXTO já marca consulta pelo MCP (`lib/mcp/tools/agendamento.ts`),
 * mas a voz não tinha nenhuma dessas ferramentas: quem ligava ouvia "vou
 * verificar" e o horário não era marcado. Este arquivo é a PONTE, e ele não
 * reimplementa nada: cada operação chama o `handler` de verdade da tool de
 * texto, com o `McpContext` montado a partir da LIGAÇÃO.
 *
 * Por que aqui (worker) e não no bridge:
 * - o bridge (`audioSocketBridge.ts`) fala com a OpenAI e não conhece banco —
 *   ele só declara as tools, guarda o preparo pendente da ligação e devolve
 *   TEXTO curto para o modelo falar;
 * - `supabase`, `organizationId` e `contactId` vêm da linha de `voice_calls`
 *   (workers/voice-agent/index.ts), nunca dos argumentos da tool.
 *
 * ⚠️ AUTORIZAÇÃO: os handlers são chamados DIRETO, sem passar pelo
 * `requiresRole`/`requiresScope` do MCP (`lib/mcp/types.ts`). Isso é de
 * propósito e é o desenho: numa ligação não existe token de API nem papel de
 * usuário — a autorização é ter entrado na fila do SIP e o agente estar
 * configurado para aquela organização (checado em `handleAudioSocketConnection`
 * antes de abrir a sessão paga). O caminho de TEXTO continua com a régua dele,
 * intacta: nada aqui afrouxa o `guard` do MCP.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpContext } from "@/lib/mcp/types";
import {
  crmBookAppointment,
  crmFindFreeSlots,
  crmListAppointments,
  crmListEventTypes,
  crmRescheduleAppointment,
} from "@/lib/mcp/tools/agendamento";

/** Dias que a voz olha para a frente quando a pessoa não diz o dia. */
const DIAS_A_FRENTE_PADRAO = 7;
/** Teto de opções FALADAS por resposta — mais que isso vira lista de telefone. */
const OPCOES_FALADAS = 3;

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/**
 * O contrato que o bridge consome. Tudo devolve TEXTO pronto para o modelo
 * falar: nada de JSON, nada de UUID (`compromisso.id` morre aqui dentro).
 */
export interface ArgsDeHorarios {
  tipo: string;
  dia?: string;
  dias_a_frente?: number;
}

export interface ArgsDeCompromissos {
  dia?: string;
}

export interface ArgsDePreparo {
  tipo: string;
  hora: string;
  dia?: string;
  dias_a_frente?: number;
  remarcar?: boolean;
}

export interface PreparoDaVoz {
  operacao: "marcar" | "remarcar";
  /** Argumentos do handler, SEM organização e SEM contato — os dois vêm da ligação. */
  args: Record<string, unknown>;
  /** Frase pronta para ser LIDA EM VOZ ALTA: tipo, dia e hora. */
  resumo: string;
}

export interface RecusaDaVoz {
  recusa: string;
}

export interface AgendaDaVoz {
  listarTipos(): Promise<string>;
  horariosLivres(args: ArgsDeHorarios): Promise<string>;
  listarCompromissos(args: ArgsDeCompromissos): Promise<string>;
  preparar(args: ArgsDePreparo): Promise<PreparoDaVoz | RecusaDaVoz>;
  executar(operacao: PreparoDaVoz["operacao"], args: Record<string, unknown>): Promise<string>;
}

export interface ContextoDaAgendaNaVoz {
  supabase: SupabaseClient;
  /** Da linha de `voice_calls` — a ÚNICA organização que esta ligação alcança. */
  organizationId: string;
  callId: string;
  agentId?: string | null;
  /** Quem está sendo atendido. Sem contato não há para quem marcar. */
  contactId: string | null;
}

// ─── fala ────────────────────────────────────────────────────────────────────

/** "segunda-feira 10/11 às 14:00" → "segunda-feira, 10 de novembro, às 14 horas". */
export function falarQuando(quando: string): string {
  const m = /^(\S+) (\d{2})\/(\d{2}) às (\d{2}):(\d{2})$/.exec(quando.trim());
  if (!m) return quando.trim();
  const [, diaDaSemana, dia, mes, hora, minuto] = m;
  const horaFalada = minuto === "00" ? `${Number(hora)} horas` : `${Number(hora)} e ${Number(minuto)}`;
  return `${diaDaSemana}, ${Number(dia)} de ${MESES[Number(mes) - 1] ?? ""}, às ${horaFalada}`.replace(
    "de ,",
    "de",
  );
}

/** A hora de um `quando` — "14:00". Vazia quando o rótulo não é o esperado. */
function horaDoQuando(quando: string): string {
  const marca = quando.lastIndexOf(" às ");
  return marca === -1 ? "" : quando.slice(marca + 4).trim();
}

/** Aceita "14:00", "14h", "14h30", "9" — a fala vira esses formatos todos. */
export function normalizarHora(texto: string): string | null {
  const cru = texto.trim().toLowerCase().replace(/h/g, ":").replace(/:$/, "");
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(cru);
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = Number(m[2] ?? "00");
  if (hora > 23 || minuto > 59) return null;
  return `${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`;
}

/** No máximo DUAS frases — o que sai daqui é falado, não lido na tela. */
function duasFrases(texto: string): string {
  const frases = texto
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((f) => f.length > 0);
  return frases.slice(0, 2).join(" ");
}

/** Lista falada: "a, b e c". */
function juntarFalado(itens: string[]): string {
  if (itens.length === 0) return "";
  if (itens.length === 1) return itens[0]!;
  return `${itens.slice(0, -1).join(", ")} e ${itens.at(-1)!}`;
}

function textoDe(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

function listaDe<T>(valor: unknown): T[] {
  return Array.isArray(valor) ? (valor as T[]) : [];
}

// ─── tipos que as tools publicam ─────────────────────────────────────────────

interface TipoFalado {
  slug: string;
  nome: string;
  duracao_minutos?: number;
}

interface HorarioFalado {
  inicio: string;
  quando: string;
}

interface CompromissoFalado {
  id: string;
  titulo?: string;
  inicio: string;
  quando: string;
  situacao?: string;
  tipo?: { slug: string; nome: string } | null;
}

interface PayloadDeHorarios {
  horarios?: HorarioFalado[];
  motivo?: string;
  mensagem?: string;
  publicou_horarios?: boolean;
}

// ─── a ponte ─────────────────────────────────────────────────────────────────

export function montarAgendaDaVoz(entrada: ContextoDaAgendaNaVoz): AgendaDaVoz {
  /**
   * O contexto de TODA chamada de tool nasce daqui, e só daqui.
   *
   * `organizationId` e `contatoDoTurno` são da LIGAÇÃO; `supabase` é o admin
   * client do worker. Nenhum argumento vindo do modelo alcança estes campos —
   * é o que impede uma ligação de uma organização ler ou escrever na agenda de
   * outra. (`contatoDoTurno` faz `crm_list_appointments` recusar consulta de
   * outro contato sem que este arquivo repita a régua.)
   */
  function contextoDaTool(): McpContext {
    return {
      organizationId: entrada.organizationId,
      role: "ai_operator",
      actor: {
        type: "ai_agent",
        id: entrada.callId,
        role: "ai_operator",
        ...(entrada.agentId ? { agent_id: entrada.agentId } : {}),
      },
      // Ligação não tem token de API: o campo existe no tipo, e é vazio de
      // propósito — nenhuma tool de agenda o persiste.
      apiTokenId: "",
      requestId: entrada.callId,
      supabase: entrada.supabase,
      ...(entrada.contactId ? { contatoDoTurno: entrada.contactId } : {}),
    };
  }

  /** Cache por LIGAÇÃO: o nome do tipo não muda no meio da conversa. */
  let tiposDaOrg: TipoFalado[] | null = null;

  async function tipos(): Promise<TipoFalado[]> {
    if (tiposDaOrg !== null) return tiposDaOrg;
    const r = (await crmListEventTypes.handler({}, contextoDaTool())) as {
      tipos?: TipoFalado[];
    };
    tiposDaOrg = listaDe<TipoFalado>(r.tipos);
    return tiposDaOrg;
  }

  async function nomeDoTipo(slug: string): Promise<string> {
    const achado = (await tipos()).find((t) => t.slug === slug);
    return achado?.nome ?? "";
  }

  async function horariosLivresDoPeriodo(
    tipo: string,
    args: { dia?: string; dias_a_frente?: number },
  ): Promise<PayloadDeHorarios> {
    return (await crmFindFreeSlots.handler(
      {
        event_type_slug: tipo,
        // `dia` sozinho recorta naquele dia civil; sem ele, a janela é relativa
        // (o modelo da voz NÃO sabe que dia é hoje — ver INSTRUCAO_AGENDA).
        ...(args.dia ? { dia: args.dia } : { dias_a_frente: args.dias_a_frente ?? DIAS_A_FRENTE_PADRAO }),
      },
      contextoDaTool(),
    )) as PayloadDeHorarios;
  }

  /** Até 2 alternativas para oferecer quando o horário pedido não serve. */
  function alternativasFaladas(payload: PayloadDeHorarios, horaPedida?: string): string {
    const opcoes = listaDe<HorarioFalado>(payload.horarios)
      .filter((h) => horaPedida === undefined || horaDoQuando(h.quando) !== horaPedida)
      .slice(0, 2)
      .map((h) => falarQuando(h.quando));
    if (opcoes.length === 0) return "";
    return ` Tenho ${juntarFalado(opcoes)}.`;
  }

  async function compromissosFuturos(): Promise<CompromissoFalado[]> {
    const r = (await crmListAppointments.handler(
      { limite: 20 },
      contextoDaTool(),
    )) as { compromissos?: CompromissoFalado[]; mensagem?: string };
    const agora = Date.now();
    return listaDe<CompromissoFalado>(r.compromissos)
      .filter((c) => {
        if (c.situacao !== "confirmed" && c.situacao !== "pending") return false;
        const inicio = new Date(c.inicio).getTime();
        return Number.isFinite(inicio) && inicio > agora;
      })
      .sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime());
  }

  return {
    async listarTipos() {
      const r = (await crmListEventTypes.handler({}, contextoDaTool())) as {
        tipos?: TipoFalado[];
        mensagem?: string;
      };
      const lista = listaDe<TipoFalado>(r.tipos);
      if (lista.length === 0) {
        return duasFrases(
          textoDe(r.mensagem) ||
            "Não encontrei os atendimentos cadastrados nesta empresa. Alguém da equipe confirma.",
        );
      }
      const falados = lista
        .slice(0, OPCOES_FALADAS)
        .map((t) =>
          t.duracao_minutos
            ? `${t.nome}, ${t.duracao_minutos} minutos`
            : t.nome,
        );
      return duasFrases(`Os atendimentos são: ${juntarFalado(falados)}. Qual deles você quer?`);
    },

    async horariosLivres(args) {
      const tipo = textoDe(args.tipo);
      if (tipo === "") return "Preciso saber qual atendimento você quer antes de olhar a agenda.";
      const payload = await horariosLivresDoPeriodo(tipo, args);
      const horarios = listaDe<HorarioFalado>(payload.horarios);
      if (horarios.length === 0) {
        if (payload.publicou_horarios === false) {
          return "O atendente ainda não publicou os horários dele. Alguém da equipe confirma.";
        }
        return duasFrases(
          textoDe(payload.mensagem) ||
            "Não achei horário livre nesse período. Quer que eu olhe outro dia?",
        );
      }
      const falados = horarios.slice(0, OPCOES_FALADAS).map((h) => falarQuando(h.quando));
      return duasFrases(`Tenho ${juntarFalado(falados)}. Qual serve para você?`);
    },

    async listarCompromissos(args) {
      const r = (await crmListAppointments.handler(
        { limite: 20, ...(args.dia ? { dia: args.dia } : {}) },
        contextoDaTool(),
      )) as { compromissos?: CompromissoFalado[]; mensagem?: string };
      const lista = listaDe<CompromissoFalado>(r.compromissos).filter(
        (c) => c.situacao !== "cancelled",
      );
      if (lista.length === 0) {
        return duasFrases(
          textoDe(r.mensagem) || "Não encontrei nenhum compromisso marcado no seu nome.",
        );
      }
      const primeiro = lista[0]!;
      const nome = primeiro.titulo || primeiro.tipo?.nome || "um compromisso";
      if (lista.length === 1) {
        return duasFrases(`Você tem ${nome} em ${falarQuando(primeiro.quando)}.`);
      }
      return duasFrases(
        `Você tem ${nome} em ${falarQuando(primeiro.quando)}, e mais ${lista.length - 1}. ` +
          "Quer remarcar algum deles?",
      );
    },

    async preparar(args) {
      if (!entrada.contactId) {
        return {
          recusa:
            "Não consigo marcar por esta ligação porque não identifiquei seu cadastro. Alguém da equipe confirma com você.",
        };
      }
      const hora = normalizarHora(textoDe(args.hora));
      if (hora === null) {
        return { recusa: "Não entendi a hora — pode repetir que horas você prefere?" };
      }

      if (args.remarcar === true) {
        const futuros = await compromissosFuturos();
        const atual = futuros[0];
        if (!atual) {
          return { recusa: "Não encontrei compromisso marcado no seu nome. Quer marcar um novo?" };
        }
        const tipoDoCompromisso = atual.tipo?.slug ?? "";
        if (tipoDoCompromisso === "") {
          return {
            recusa:
              "Não consegui identificar o tipo do seu compromisso para achar outro horário. Alguém da equipe confirma.",
          };
        }
        const payload = await horariosLivresDoPeriodo(tipoDoCompromisso, args);
        const horarios = listaDe<HorarioFalado>(payload.horarios);
        const escolhido = horarios.find((h) => horaDoQuando(h.quando) === hora);
        if (!escolhido) {
          const alternativas = alternativasFaladas(payload, hora);
          return {
            recusa: duasFrases(
              alternativas === ""
                ? "Não tem vaga nesse horário. Quer que eu olhe outro dia?"
                : `Não tem vaga nesse horário.${alternativas}`,
            ),
          };
        }
        const nome = atual.tipo?.nome || (await nomeDoTipo(tipoDoCompromisso)) || "seu compromisso";
        return {
          operacao: "remarcar",
          // Só o que o handler precisa: a organização e o contato vêm da ligação.
          args: { appointment_id: atual.id, new_starts_at: escolhido.inicio },
          resumo: duasFrases(
            `Remarcar ${nome}, de ${falarQuando(atual.quando)} para ${falarQuando(escolhido.quando)}.`,
          ),
        };
      }

      const tipo = textoDe(args.tipo);
      if (tipo === "") {
        return { recusa: "Preciso saber qual atendimento você quer marcar." };
      }
      const payload = await horariosLivresDoPeriodo(tipo, args);
      const horarios = listaDe<HorarioFalado>(payload.horarios);
      const escolhido = horarios.find((h) => horaDoQuando(h.quando) === hora);
      if (!escolhido) {
        const alternativas = alternativasFaladas(payload, hora);
        return {
          recusa: duasFrases(
            alternativas === ""
              ? "Não tem vaga nesse horário. Quer que eu olhe outro dia?"
              : `Não tem vaga nesse horário.${alternativas}`,
          ),
        };
      }
      const nome = (await nomeDoTipo(tipo)) || tipo;
      return {
        operacao: "marcar",
        args: { event_type_slug: tipo, starts_at: escolhido.inicio },
        resumo: duasFrases(`${nome}, ${falarQuando(escolhido.quando)}.`),
      };
    },

    async executar(operacao, args) {
      if (operacao === "marcar") {
        if (!entrada.contactId) {
          return "Não consigo marcar por esta ligação. Alguém da equipe confirma com você.";
        }
        // A validação é o schema da PRÓPRIA tool de texto: se um dia o contrato
        // dela mudar, quem quebra aqui é este ponto, não a agenda.
        const lido = z.object(crmBookAppointment.inputSchema).safeParse({
          ...args,
          contact_id: entrada.contactId,
        });
        if (!lido.success) {
          return "Não consegui concluir o agendamento. Alguém da equipe confirma com você.";
        }
        const r = (await crmBookAppointment.handler(lido.data, contextoDaTool())) as {
          marcado?: boolean;
          compromisso?: { quando?: string; title?: string };
          aguarda_confirmacao?: boolean;
          mensagem?: string;
          motivo?: string;
        };
        const quando = textoDe(r.compromisso?.quando);
        if (r.marcado === false || quando === "") {
          return await recusaDeEscrita(r, args, operacao);
        }
        if (r.aguarda_confirmacao === true) {
          return duasFrases(
            `Separei ${falarQuando(quando)} para você. O horário ficou reservado e a equipe confirma.`,
          );
        }
        return duasFrases(`Pronto: marquei ${falarQuando(quando)}.`);
      }

      const lido = z.object(crmRescheduleAppointment.inputSchema).safeParse(args);
      if (!lido.success) {
        return "Não consegui concluir a remarcação. Alguém da equipe confirma com você.";
      }
      const r = (await crmRescheduleAppointment.handler(lido.data, contextoDaTool())) as {
        remarcado?: boolean;
        compromisso?: { quando?: string };
        mensagem?: string;
        motivo?: string;
      };
      const quando = textoDe(r.compromisso?.quando);
      if (r.remarcado === false || quando === "") {
        return await recusaDeEscrita(r, args, operacao);
      }
      return duasFrases(`Pronto: remarquei para ${falarQuando(quando)}.`);
    },
  };

  /**
   * Recusa de ESCRITA: a mensagem do handler já é a face do cliente, mas em voz
   * ela vem com instrução de modelo ("chame `crm_find_free_slots`"). Quando o
   * motivo é choque de horário, a fala certa é oferecer alternativas — nunca
   * repetir o horário que acabou de ser recusado.
   */
  async function recusaDeEscrita(
    r: { mensagem?: string; motivo?: string },
    args: Record<string, unknown>,
    operacao: PreparoDaVoz["operacao"],
  ): Promise<string> {
    const motivo = textoDe(r.motivo);
    const choqueDeHorario =
      motivo === "agenda_horario_indisponivel" || motivo === "agenda_fora_da_jornada";
    if (choqueDeHorario) {
      const tipo =
        operacao === "marcar"
          ? textoDe(args.event_type_slug)
          : (await compromissosFuturos())[0]?.tipo?.slug ?? "";
      if (tipo !== "") {
        const payload = await horariosLivresDoPeriodo(tipo, {});
        const alternativas = alternativasFaladas(payload);
        if (alternativas !== "") return duasFrases(`Não deu para confirmar esse horário.${alternativas}`);
      }
    }
    return duasFrases(
      textoDe(r.mensagem) || "Não consegui concluir o agendamento. Alguém da equipe confirma.",
    );
  }
}
