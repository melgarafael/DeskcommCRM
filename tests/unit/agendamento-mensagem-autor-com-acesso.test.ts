import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { autorAindaTemAcesso, type AgendamentoParaEnvio } from "@/lib/agendamento-mensagem/envio";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  listarAgendamentosVisiveis,
  paginaDaConsulta,
  temMaisPagina,
  type AgendamentoDaLista,
} from "@/lib/agendamento-mensagem/lista";

/**
 * Na hora do envio, quem agendou ainda é da equipe? (#3118, doc 314, pendência 3)
 *
 * O dublê responde como `user_organizations` responderia: a linha do vínculo
 * ATIVO (`revoked_at` nulo) ou nada. E registra os filtros pedidos, para o teste
 * provar que a consulta pede o vínculo ativo DESTA organização e DESTA pessoa.
 */
function adminCom(vinculo: { role: string } | null, erro: { message: string } | null = null) {
  const filtros: string[] = [];
  const consulta = {
    select: () => consulta,
    eq: (c: string, v: string) => (filtros.push(`${c}=${v}`), consulta),
    is: (c: string, v: null) => (filtros.push(`${c} is ${String(v)}`), consulta),
    maybeSingle: async () => ({ data: vinculo, error: erro }),
  };
  const admin = { from: (t: string) => (filtros.push(`from ${t}`), consulta) };
  return { admin: admin as unknown as SupabaseClient, filtros };
}

const AG: AgendamentoParaEnvio = {
  id: "a",
  organization_id: "org-1",
  contact_id: "c",
  channel_session_id: "s",
  created_by_user_id: "u-1",
  body: "oi",
};

describe("autorAindaTemAcesso", () => {
  it("pede o vínculo ATIVO desta pessoa nesta organização", async () => {
    const { admin, filtros } = adminCom({ role: "agent" });
    await autorAindaTemAcesso(admin, AG);
    expect(filtros).toEqual(["from user_organizations", "organization_id=org-1", "user_id=u-1", "revoked_at is null"]);
  });

  it("atendente, gestor e admin seguem enviando", async () => {
    for (const role of ["agent", "manager", "admin"]) {
      expect(await autorAindaTemAcesso(adminCom({ role }).admin, AG)).toBe(true);
    }
  });

  it("sem vínculo ativo (saiu da empresa) ou só leitura, não envia", async () => {
    expect(await autorAindaTemAcesso(adminCom(null).admin, AG)).toBe(false);
    expect(await autorAindaTemAcesso(adminCom({ role: "viewer" }).admin, AG)).toBe(false);
  });

  it("conta apagada (created_by nulo) não envia", async () => {
    expect(await autorAindaTemAcesso(adminCom({ role: "admin" }).admin, { ...AG, created_by_user_id: null })).toBe(false);
  });

  it("leitura que falhou não vira 'tem acesso' — lança e a rodada tenta de novo", async () => {
    await expect(autorAindaTemAcesso(adminCom(null, { message: "boom" }).admin, AG)).rejects.toThrow("leitura_do_vinculo_falhou");
  });
});

/**
 * "EXIBIR TODOS" — a lista de envios de TODOS os clientes (segunda parte da
 * #3118) segue a MESMA régua de escopo da linha acima: a visibilidade é a da
 * CONVERSA, decidida pela RLS, não a de quem agendou.
 *
 * O dublê abaixo responde como a policy `mensagens_agendadas_select` responde
 * numa sessão de gestor: devolve a linha cuja conversa está no conjunto visível
 * e esconde a das outras. Quem só enxerga o que a sessão entrega é a própria
 * consulta — por isso o único jeito de a linha "de fora" aparecer no teste é a
 * consulta furar o escopo (cliente de admin, lista de conversas montada em
 * código, filtro por autor que traga o mundo).
 */
type LinhaCrua = AgendamentoDaLista & { organization_id: string; created_by_user_id: string | null };

const OUTRO_ATENDENTE = "u-outro";
const GESTOR = "u-gestor";

const ENVIO_DO_GESTOR: LinhaCrua = {
  id: "ag-do-gestor",
  organization_id: "org-1",
  conversation_id: "conv-do-gestor",
  created_by_user_id: GESTOR,
  contact_id: "contato-1",
  title: null,
  body: "oi do gestor",
  scheduled_at: "2026-11-14T12:00:00.000Z",
  status: "agendada",
  se_desconectado: "esperar",
  motivo: null,
  created_at: "2026-11-13T10:00:00.000Z",
  mensagem: null,
  contato: { name: "Ana", phone_number: "5511999990000" },
};

/** O envio do COLEGA, numa conversa que o gestor enxerga (equipe/setor). */
const ENVIO_DO_OUTRO: LinhaCrua = {
  ...ENVIO_DO_GESTOR,
  id: "ag-do-outro",
  conversation_id: "conv-do-outro-atendente",
  created_by_user_id: OUTRO_ATENDENTE,
  body: "oi do colega",
  scheduled_at: "2026-11-14T13:00:00.000Z",
  contato: { name: "Bruno", phone_number: "5511988887777" },
};

/** A conversa de OUTRA equipe: a RLS não entrega, e a linha não pode vazar. */
const ENVIO_FORA_DO_ESCOPO: LinhaCrua = {
  ...ENVIO_DO_GESTOR,
  id: "ag-fora",
  conversation_id: "conv-de-outra-equipe",
  created_by_user_id: OUTRO_ATENDENTE,
  body: "oi de outra equipe",
  scheduled_at: "2026-11-14T14:00:00.000Z",
};

function sessaoComRls(linhas: LinhaCrua[], visiveis: Set<string>) {
  const pedidos: string[] = [];
  let org: string | null = null;
  let autor: string | null = null;
  let janela: [number, number] = [0, Number.MAX_SAFE_INTEGER];
  // A direção pedida em `order(...)` vale no dublê: sem isso, o teste não vê a
  // regressão para a ordem ascendente.
  let descendente = false;

  /** A policy: organização da sessão + conversa visível. Nada de autor aqui. */
  const escopo = () => linhas.filter((l) => l.organization_id === org && visiveis.has(l.conversation_id));
  const respondidas = () => {
    const base = escopo().filter((l) => autor === null || l.created_by_user_id === autor);
    const sinal = descendente ? -1 : 1;
    const ordenadas = [...base].sort(
      (a, b) => sinal * (a.scheduled_at.localeCompare(b.scheduled_at) || a.id.localeCompare(b.id)),
    );
    return { data: ordenadas.slice(janela[0], janela[1] + 1), error: null, count: base.length };
  };

  const consulta = {
    select: (_colunas: string, opcoes?: { count?: string }) => {
      pedidos.push(`select count=${opcoes?.count ?? "sem"}`);
      return consulta;
    },
    eq: (coluna: string, valor: string) => {
      if (coluna === "organization_id") org = valor;
      if (coluna === "created_by_user_id") autor = valor;
      pedidos.push(`${coluna}=${valor}`);
      return consulta;
    },
    order: (coluna: string, opcoes?: { ascending?: boolean }) => {
      if (coluna === "scheduled_at") descendente = opcoes?.ascending === false;
      pedidos.push(`order ${coluna} ${opcoes?.ascending === false ? "desc" : "asc"}`);
      return consulta;
    },
    range: (inicio: number, fim: number) => {
      janela = [inicio, fim];
      pedidos.push(`range ${inicio}..${fim}`);
      return Promise.resolve(respondidas());
    },
  };
  const sessao = { from: (tabela: string) => (pedidos.push(`from ${tabela}`), consulta) };
  return { sessao: sessao as unknown as SupabaseClient, pedidos };
}

const VISIVEIS_DO_GESTOR = new Set(["conv-do-gestor", "conv-do-outro-atendente"]);

describe("listarAgendamentosVisiveis — o 'Exibir todos' cruza a empresa pela conversa", () => {
  it("o gestor vê o envio que OUTRO atendente agendou numa conversa da equipe", async () => {
    const { sessao } = sessaoComRls([ENVIO_DO_GESTOR, ENVIO_DO_OUTRO], VISIVEIS_DO_GESTOR);
    const { linhas } = await listarAgendamentosVisiveis(sessao, {
      organizationId: "org-1",
      limite: LIMITE_PADRAO,
      deslocamento: 0,
    });
    expect(linhas.map((l) => l.id)).toContain("ag-do-outro");
    expect(linhas.map((l) => l.id)).toContain("ag-do-gestor");
    // A linha do colega tem outro autor: só entrou porque o escopo é a conversa.
    expect(linhas.find((l) => l.id === "ag-do-outro")?.contato?.name).toBe("Bruno");
  });

  it("a conversa fora do escopo do gestor NÃO aparece — nem a linha, nem na contagem", async () => {
    const { sessao } = sessaoComRls(
      [ENVIO_DO_GESTOR, ENVIO_DO_OUTRO, ENVIO_FORA_DO_ESCOPO],
      VISIVEIS_DO_GESTOR,
    );
    const { linhas, total } = await listarAgendamentosVisiveis(sessao, {
      organizationId: "org-1",
      limite: LIMITE_PADRAO,
      deslocamento: 0,
    });
    expect(linhas.map((l) => l.id)).not.toContain("ag-fora");
    expect(total).toBe(2);
  });

  it("não filtra por autor: é a RLS da conversa que decide, não o `created_by_user_id`", async () => {
    const { sessao, pedidos } = sessaoComRls([ENVIO_DO_GESTOR, ENVIO_DO_OUTRO], VISIVEIS_DO_GESTOR);
    await listarAgendamentosVisiveis(sessao, { organizationId: "org-1", limite: LIMITE_PADRAO, deslocamento: 0 });
    expect(pedidos.some((p) => p.startsWith("created_by_user_id="))).toBe(false);
  });

  it("pagina com limite explícito e conta o total ANTES de cortar a página", async () => {
    const { sessao, pedidos } = sessaoComRls([ENVIO_DO_GESTOR, ENVIO_DO_OUTRO], VISIVEIS_DO_GESTOR);
    const primeira = await listarAgendamentosVisiveis(sessao, { organizationId: "org-1", limite: 1, deslocamento: 0 });
    expect(pedidos).toContain("range 0..0");
    expect(pedidos).toContain("select count=exact");
    expect(primeira.total).toBe(2);
    // O mais recente/futuro primeiro, como na lista da conversa: em ordem
    // ascendente, o histórico resolvido enchia a página 1 e escondia o pendente.
    expect(pedidos).toContain("order scheduled_at desc");
    expect(primeira.linhas.map((l) => l.id)).toEqual(["ag-do-outro"]);

    const segunda = await listarAgendamentosVisiveis(sessao, { organizationId: "org-1", limite: 1, deslocamento: 1 });
    expect(pedidos).toContain("range 1..1");
    expect(segunda.linhas.map((l) => l.id)).toEqual(["ag-do-gestor"]);
    expect(temMaisPagina(1, segunda.linhas.length, segunda.total, 1)).toBe(false);
  });
});

describe("paginaDaConsulta — o teto do limite é do servidor", () => {
  const params = (q: Record<string, string>) => ({ get: (nome: string) => q[nome] ?? null });

  it("vale o padrão quando o pedido não traz limite", () => {
    expect(paginaDaConsulta(params({}))).toEqual({ limite: LIMITE_PADRAO, deslocamento: 0 });
  });

  it("o limite não passa do teto, e lixo/zero/negativo cai no padrão", () => {
    expect(paginaDaConsulta(params({ limit: "999" })).limite).toBe(LIMITE_MAXIMO);
    expect(paginaDaConsulta(params({ limit: "0" })).limite).toBe(LIMITE_PADRAO);
    expect(paginaDaConsulta(params({ limit: "-3" })).limite).toBe(LIMITE_PADRAO);
    expect(paginaDaConsulta(params({ limit: "abc" })).limite).toBe(LIMITE_PADRAO);
  });

  it("offset negativo vira 0 e offset válido passa", () => {
    expect(paginaDaConsulta(params({ offset: "-7" })).deslocamento).toBe(0);
    expect(paginaDaConsulta(params({ offset: "7" })).deslocamento).toBe(7);
  });
});
