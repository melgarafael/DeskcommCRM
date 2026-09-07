import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ALVO_DE_VINCULO_DO_AGENDAMENTO, VINCULO_DE_AGENDAMENTO } from "@/lib/agenda/tipos";
import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * O LAÇO DE RETORNO DA AGENDA, PROVADO NA GRAVAÇÃO — não na decisão.
 *
 * ## O defeito que esta cerca fecha
 *
 * `atividadeDaTransicao` (lib/agenda/laco.ts) decide QUAL atividade cada
 * transição emite, e `tests/unit/agenda-laco-de-retorno.test.ts` a cobre bem.
 * Só que ela é função pura: devolver `"appointment_scheduled"` não põe linha
 * nenhuma em `crm_lead_activities`. Quem grava é `fecharOLaco`, dentro do
 * handler, e até aqui nenhum teste passava por lá:
 *
 *     grep -rln "appointment_scheduled" tests/unit
 *     # antes deste arquivo: só agenda-laco-de-retorno.test.ts (função pura)
 *
 * Entre a decisão certa e a linha gravada há três coisas que podem cair sem
 * ninguém notar — o roteamento do negócio do contato, o mapeamento do autor
 * (`sync` não existe no CHECK de `actor_kind`) e o próprio INSERT. Todas falham
 * em RUNTIME, dentro de caminho fire-and-forget, e o sintoma é a timeline
 * simplesmente não contando que houve consulta marcada. Ninguém abre chamado
 * por linha que não nasceu.
 *
 * ## Onde a sonda olha
 *
 * No EFEITO, nunca na chamada: este arquivo não mocka `emitLeadActivity` nem
 * `registraFalhaDeAtividade` — ele lê o que chegou ao dublê do Supabase
 * (`banco.inserido["crm_lead_activities"]` e as chamadas de `rpc("emit_event")`).
 * Um teste que espia a função continua verde no dia em que ela para de gravar.
 *
 * ## Isto foi sabotado — os dentes são medidos, não afirmados (2026-08-27)
 *
 * Cada linha é um defeito plantado no código de produção, medido, e restaurado
 * byte a byte em seguida. As seis previsões foram escritas ANTES de rodar e as
 * seis bateram:
 *
 *   INSERT da atividade morto (tabela renomeada)          → 3: marcar, cancelar, remarcar
 *   roteamento anulado (`leadId = contactId`)             → 2: marcar, sem-negócio-avisa
 *   `actorParaAtividade` devolve `system` para `user`     → 1: marcar
 *   `rescheduled` passa a emitir `appointment_cancelled`  → 1: remarcar
 *   o ramo `!leadId` deixa de avisar                      → 1: sem-negócio-avisa
 *   `emitLeadActivity` LANÇA em vez de devolver `{ok}`    → 2: mutação-sobrevive, dívida
 *
 * ## `autorParaTimeline` NÃO decide o que é gravado — medido, não deduzido
 *
 * Quebrá-la (fazer `user` deixar de ser `user`) deixa este arquivo INTEIRO
 * verde. O `actorKind` que `fecharOLaco` passa a `emitLeadActivity` não é campo
 * de `EmitLeadActivityInput`: o `as never` da chamada silencia a propriedade
 * excedente e `buildLeadActivityRow` computa `actor_kind` de
 * `actorParaAtividade(input.actor)`, ignorando o que veio. Quem protege o CHECK
 * hoje é essa outra função — nenhum caminho dela devolve `sync`. Os casos daqui
 * asseram o `actor_kind` do EFEITO, então seguem valendo no dia em que a
 * chamada passar a ser respeitada; o que eles não fazem é provar a função que
 * o handler pensa estar usando.
 *
 * ## O que esta cerca NÃO cobre — e onde mais ninguém cobre
 *
 * `fecharOLaco` tem TRÊS emissores; este arquivo mede dois (a atividade e o
 * vínculo). O terceiro é o `event_log` de `agenda.appointment.push_to_google`:
 * sabotá-lo (`if (false && args.empurrarAoGoogle)`) não reprova nenhum caso
 * daqui. Ficar de fora é escolha — é o emissor sem consumidor declarado no
 * próprio `fecharOLaco` —, mas não estar coberto em LUGAR NENHUM não é:
 *
 *     grep -rln "push_to_google" tests   # vazio em 2026-08-27
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/agenda-emite-atividade.test.ts
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn() };
});

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { marcarAgendamentoHandler, alterarAgendamentoHandler, cancelarAgendamentoHandler } =
  await import("@/app/api/v1/agenda/agendamentos/_handler");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const USUARIO = "bbbbbbbb-0000-4000-8000-00000000000b";
const TIPO = "cccccccc-0000-4000-8000-00000000000c";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";
const NEGOCIO = "eeeeeeee-0000-4000-8000-00000000000e";
const AGENDAMENTO = "ffffffff-0000-4000-8000-00000000000f";

const HORARIO = "2026-09-02T13:00:00.000Z";
const OUTRO_HORARIO = "2026-09-02T15:00:00.000Z";

type Linha = Record<string, unknown>;

/**
 * O banco do caso — fixture e sonda no mesmo objeto.
 *
 * `erroAoGravar` é o que permite provar a falha de escrita SEM mockar o
 * emissor: basta o INSERT em `crm_lead_activities` voltar com erro, que é
 * exatamente o que o Postgres faz quando a FK de `actor_agent_id` ou o CHECK de
 * `actor_kind` recusam a linha.
 */
interface Banco {
  tipo: Linha | null;
  contato: Linha | null;
  agendamento: Linha | null;
  negocios: Linha[];
  criado: Linha | null;
  erroAoGravar: Record<string, string>;
  inserido: Record<string, Linha[]>;
  rpc: Array<{ fn: string; args: Linha }>;
}

let banco: Banco;
/** O horário que a coleta oferece; a escrita só aceita slot que ela ofereceu. */
let horarioOfertado: string;

function negocioAberto(): Linha {
  return {
    id: NEGOCIO,
    organization_id: ORG,
    pipeline_id: "11111111-0000-4000-8000-000000000011",
    status: "open",
    last_activity_at: "2026-08-30T10:00:00.000Z",
    created_at: "2026-08-01T10:00:00.000Z",
  };
}

function coletaOk(): ResultadoDaConsulta {
  const inicio = new Date(horarioOfertado);
  return {
    ok: true,
    slots: [{ inicio, fim: new Date(inicio.getTime() + 30 * 60_000) }],
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
  };
}

function dadoDaTabela(tabela: string): unknown {
  switch (tabela) {
    case "calendar_event_types":
      return banco.tipo;
    case "contacts":
      return banco.contato;
    case "calendar_appointments":
      return banco.agendamento;
    case "crm_leads":
      return banco.negocios;
    case "crm_pipelines":
      return null;
    default:
      return null;
  }
}

function cliente(): SupabaseClient {
  const leitura = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "is", "not", "or", "gte", "lte", "order", "limit"]) {
      cadeia[m] = () => cadeia;
    }
    const resposta = () => ({ data: dadoDaTabela(tabela), error: null });
    cadeia.maybeSingle = async () => resposta();
    cadeia.single = async () => resposta();
    cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        const erro = banco.erroAoGravar[tabela];
        if (!erro) (banco.inserido[tabela] ??= []).push(linha);
        const resposta = {
          data: erro ? null : (banco.criado ?? linha),
          error: erro ? { message: erro } : null,
        };
        return {
          select: () => ({ single: async () => resposta, maybeSingle: async () => resposta }),
          then: (r: (v: unknown) => unknown) => r(resposta),
        };
      },
      update: (patch: Linha) => {
        const cadeia: Record<string, unknown> = {};
        const resposta = () => ({ data: { ...(banco.agendamento ?? {}), ...patch }, error: null });
        for (const m of ["eq", "in"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => resposta();
        cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
        return cadeia;
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      banco.rpc.push({ fn, args });
      if(fn==="fn_appointment_change") {
        expect(args.p_org).toBe(ORG);expect(args.p_id).toBe(AGENDAMENTO);
        return {data:{...banco.agendamento,...args.p_patch as Linha,revision:2},error:null};
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO, role: "admin" },
  requestId: "req-1",
};

/** As linhas que chegaram à timeline. */
function atividades(): Linha[] {
  return banco.inserido["crm_lead_activities"] ?? [];
}

/** Os avisos de rastro perdido que chegaram ao `event_log`. */
function avisosDeRastroPerdido(): Array<{ fn: string; args: Linha }> {
  return banco.rpc.filter(
    (c) => c.fn === "emit_event" && c.args.p_event_type === "crm.activity_write_failed",
  );
}

beforeEach(() => {
  // O mock de `audit` acumula chamadas entre casos; limpar ANTES de configurar.
  vi.clearAllMocks();
  horarioOfertado = HORARIO;
  banco = {
    tipo: {
      id: TIPO,
      name: "Consulta",
      is_active: true,
      duration_minutes: 30,
      default_owner_user_id: USUARIO,
      requires_confirmation: false,
      location_kind: "in_person",
      location_details: null,
    },
    contato: { id: CONTATO },
    agendamento: {
      id: AGENDAMENTO,
      event_type_id: TIPO,
      owner_user_id: USUARIO,
      contact_id: CONTATO,
      starts_at: HORARIO,
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    negocios: [negocioAberto()],
    criado: {
      id: AGENDAMENTO,
      starts_at: HORARIO,
      ends_at: "2026-09-02T13:30:00.000Z",
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    erroAoGravar: {},
    inserido: {},
    rpc: [],
  };
  vi.mocked(horariosLivresDaOrg).mockImplementation(async () => coletaOk());
});

describe("a agenda grava na timeline", () => {
  it("marcar nasce como `appointment_scheduled` no negócio do contato", async () => {
    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    expect(
      atividades(),
      "marcar não gravou atividade nenhuma: a equipe abre o dossiê do cliente e não vê que há consulta marcada — e quem lê a timeline conclui que ninguém falou com ele",
    ).toHaveLength(1);
    const linha = atividades()[0]!;
    expect(
      linha.type,
      "a atividade nasceu com outro tipo: a timeline mostra uma frase errada sobre o que aconteceu, e ninguém desconfia de uma linha que existe",
    ).toBe("appointment_scheduled");
    expect(
      linha.lead_id,
      "a atividade foi ancorada no negócio errado (ou no id do contato): o rastro da consulta aparece no dossiê de outra pessoa",
    ).toBe(NEGOCIO);
    expect(
      linha.source_id,
      "a atividade não aponta para o compromisso: quem vê a linha na timeline não tem como chegar ao horário marcado",
    ).toBe(AGENDAMENTO);
    expect(
      linha.actor_kind,
      "o autor humano virou outra coisa na timeline: a tela deixa de dizer que foi a atendente quem marcou",
    ).toBe("user");
    expect(
      linha.organization_id,
      "a atividade nasceu carimbada com outra organização: a consulta aparece na timeline de um cliente de OUTRA empresa e some da do dono — a RLS não pega, porque a linha saiu de dentro já com o id errado",
    ).toBe(ORG);
  });

  it("o compromisso PERTENCE ao negócio — sem o vínculo o dossiê não acha o que foi marcado", async () => {
    // A atividade e o vínculo respondem perguntas diferentes: uma aparece na
    // TIMELINE, o outro é por onde o dossiê LISTA o compromisso. Sem este caso,
    // apagar o INSERT de `crm_lead_links` deixava o arquivo verde — metade de
    // `fecharOLaco` estava fora da sonda.
    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    const vinculos = banco.inserido["crm_lead_links"] ?? [];
    expect(
      vinculos,
      "o compromisso não foi vinculado ao negócio: a timeline diz que há consulta marcada, mas o dossiê não lista o horário — quem abre o negócio para ligar não acha o que foi combinado",
    ).toHaveLength(1);
    expect(
      vinculos[0],
      "o vínculo nasceu apontando para outro lugar (negócio errado, alvo errado ou tipo de vínculo errado): o dossiê certo continua vazio e o compromisso pendura no de outra pessoa",
    ).toMatchObject({
      organization_id: ORG,
      lead_id: NEGOCIO,
      target_kind: ALVO_DE_VINCULO_DO_AGENDAMENTO,
      target_id: AGENDAMENTO,
      link_kind: VINCULO_DE_AGENDAMENTO,
    });
  });

  it("marcar SEM contato não inventa atividade — o par que prova que a sonda enxerga", async () => {
    // CONTROLE DE VACUIDADE do caso acima. Sem este par, um dublê que gravasse
    // linha por conta própria (ou uma sonda apontada para a tabela errada)
    // passaria nos dois lados sem ninguém perceber.
    await marcarAgendamentoHandler(cliente(), ctx, { event_type_id: TIPO, starts_at: HORARIO });

    expect(
      atividades(),
      "nasceu atividade para um compromisso sem contato: a timeline de alguém recebeu um agendamento que não é dele",
    ).toHaveLength(0);
    expect(
      banco.inserido["calendar_appointments"],
      "o compromisso sem contato nem chegou a ser criado — a sonda está medindo um caminho que não aconteceu",
    ).toHaveLength(1);
  });

  it("cancelar nasce como `appointment_cancelled` — é a operação que alguém pode querer negar ter feito", async () => {
    await cancelarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, reason: "cliente pediu" });

    expect(
      atividades().map((l) => l.type),
      "cancelar não deixou rastro na timeline: o horário some da grade e ninguém consegue dizer quem desmarcou nem quando",
    ).toEqual(["appointment_cancelled"]);
  });

  it("remarcar nasce como `appointment_rescheduled`, não como cancelamento seguido de marcação", async () => {
    horarioOfertado = OUTRO_HORARIO;
    await alterarAgendamentoHandler(cliente(), ctx, { id: AGENDAMENTO, starts_at: OUTRO_HORARIO });

    expect(
      atividades().map((l) => l.type),
      "remarcar contou outra história: a timeline diz que o cliente desistiu e voltou, quando ele só mudou de horário",
    ).toEqual(["appointment_rescheduled"]);
  });
});

describe("quando a gravação da timeline falha", () => {
  it("a mutação NÃO cai junto — a linha do agendamento continua nascendo", async () => {
    // Registro é fire-and-forget POR DECISÃO (activity-write-failure.ts): a
    // timeline não pode derrubar a operação que ela descreve.
    banco.erroAoGravar["crm_lead_activities"] = "23514: actor_kind inválido";

    const criado = await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    expect(
      criado.id,
      "a falha ao registrar derrubou a marcação: o cliente ouviu 'deu erro' e desligou, quando o horário dele estava livre e a operação era possível",
    ).toBe(AGENDAMENTO);
    expect(
      banco.inserido["calendar_appointments"],
      "o compromisso não foi gravado: a timeline levou a mutação junto com ela",
    ).toHaveLength(1);
    expect(
      atividades(),
      "a atividade nasceu apesar do erro — o dublê não está simulando a recusa do banco, e o caso mede outra coisa",
    ).toHaveLength(0);
  });

  it("o ramo SEM NEGÓCIO conta a perda — controle que prova que a sonda de aviso enxerga", async () => {
    // CONTROLE DE VACUIDADE do caso seguinte, e o mais importante do arquivo:
    // é a MESMA sonda (`rpc("emit_event")`) num ramo onde a contagem existe. Se
    // ela ficasse muda aqui também, "zero avisos" abaixo seria instrumento
    // morto em vez de achado.
    banco.negocios = [];

    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    expect(
      avisosDeRastroPerdido(),
      "nem o ramo previsto avisa: nenhuma perda de rastro desta feature chega ao event_log, e a garantia de '100% das mutações geram atividade' passa a ser afirmação sem medição",
    ).toHaveLength(1);
    expect(avisosDeRastroPerdido()[0]!.args.p_payload).toMatchObject({
      activity_type: "appointment_scheduled",
    });
    // O PAR do caso do vínculo: sem negócio não há onde ancorar, e nada é
    // pendurado. Sem esta linha, um INSERT incondicional passaria nos dois.
    expect(
      banco.inserido["crm_lead_links"] ?? [],
      "nasceu vínculo mesmo sem negócio para ancorar: o compromisso ficou pendurado num id que não é de negócio nenhum, e o dossiê que o listar mostra o dado de outro",
    ).toHaveLength(0);
  });

  it("⚠️ DÍVIDA CONGELADA: o ramo de ERRO não conta a perda — engoliu por esquecimento", async () => {
    // ACHADO, não conserto. `fecharOLaco` chama `registraFalhaDeAtividade`
    // APENAS quando não há negócio para ancorar (o ramo `!leadId`). O INSERT da
    // atividade fica em `await emitLeadActivity(...)` com o retorno
    // `{ ok, error }` DESCARTADO — e essa função não lança, ela devolve. Então a
    // recusa do banco não vira exceção, não vira aviso, não vira nada.
    //
    // Este caso congela a dívida em vez de fingir que ela não existe: ele fica
    // VERMELHO no dia em que o handler passar a contar, e o conserto é trocar
    // este `toHaveLength(0)` por `toHaveLength(1)` — a mesma sonda, o mesmo
    // ramo, sem tocar em mais nada.
    banco.erroAoGravar["crm_lead_activities"] = "23503: actor_agent_id viola FK";

    await marcarAgendamentoHandler(cliente(), ctx, {
      event_type_id: TIPO,
      starts_at: HORARIO,
      contact_id: CONTATO,
    });

    expect(
      avisosDeRastroPerdido(),
      "o handler passou a contar a falha de escrita da timeline (o que é o comportamento CERTO): troque este caso para exigir 1 aviso — a dívida foi paga",
    ).toHaveLength(0);
  });
});
