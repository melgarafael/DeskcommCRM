/**
 * OS AVISOS DA RECUPERAÇÃO DA QUEDA (Spec 32, seção 4), CONTRA UM BANCO DE MENTIRA.
 *
 * O dublê aqui é uma tabela em memória com o mesmo contrato que o código usa do
 * Supabase: `eq`, `gt`, `order`, `limit`, `insert`, `update`, e o índice único
 * parcial que faz o `23505`. Um mock de "chamada certa" não provaria os filtros
 * de `organization_id` nem a comparação de `created_at`, e eles são exatamente o
 * que separa um aviso correto de um vazamento entre tenants ou de um aviso fechado
 * por uma resposta de antes da queda.
 *
 * O que estes casos provam:
 *
 *  1. o resumo: a primeira chamada insere; a segunda (o índice devolve 23505)
 *     ATUALIZA o aberto e não insere outro;
 *  2. o texto de cada motivo sai como a Spec manda (cinco casos), e a concluída
 *     sem mensagem nenhuma não avisa;
 *  3. o aviso de cliente: 23505 é "já existe", não erro, e não gera log;
 *  4. fechar respondidos: resposta DEPOIS do aviso fecha; resposta ANTES não;
 *     toda consulta carrega `organization_id` nas duas tabelas;
 *  5. falha de gravação (erro ou exceção) não lança em nenhuma das quatro funções.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import {
  avisarClienteSemResposta,
  avisarResumoDaRecuperacao,
  fecharAvisosDeClienteRespondido,
  fecharResumoDaRecuperacao,
  type MotivoDoResumo,
} from "./avisos-da-queda";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CONVERSA_A = "33333333-3333-4333-8333-333333333333";
const CONVERSA_B = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;
interface ErroDoBanco {
  code?: string;
  message: string;
}
interface Resultado {
  data: Linha[] | null;
  error: ErroDoBanco | null;
}
interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update";
  filtros: Array<[string, "eq" | "gt", unknown]>;
  linha?: Linha;
  patch?: Linha;
}
interface Opcoes {
  tabelas?: Record<string, Linha[]>;
  /** Índice único parcial: duas linhas que batem nestas colunas, com `quando` valendo, dão 23505. */
  unicos?: Record<string, { colunas: string[]; quando: (l: Linha) => boolean }>;
  /** Toda operação devolve este erro (falha de gravação). */
  falha?: ErroDoBanco;
  /** Toda operação lança (a conexão caiu no meio). */
  lanca?: boolean;
}

interface Construtor {
  select(colunas?: string): Construtor;
  eq(coluna: string, valor: unknown): Construtor;
  gt(coluna: string, valor: unknown): Construtor;
  order(coluna: string): Construtor;
  limit(n: number): Construtor;
  range(de: number, ate: number): Construtor;
  insert(linha: Linha): Construtor;
  update(patch: Linha): Construtor;
  then<T1 = Resultado, T2 = never>(
    ok?: ((v: Resultado) => T1) | null,
    ko?: ((e: unknown) => T2) | null,
  ): Promise<T1 | T2>;
}

/**
 * O admin de mentira. Devolve também o registro de cada chamada, para os testes
 * conferirem a CONSULTA (o `organization_id` estava lá?), não só o resultado.
 */
function fakeAdmin(opts: Opcoes = {}) {
  const tabelas: Record<string, Linha[]> = opts.tabelas ?? {};
  const chamadas: Chamada[] = [];
  let sequencia = 0;

  const linhasDe = (tabela: string): Linha[] => (tabelas[tabela] ??= []);
  const casa = (l: Linha, filtros: Chamada["filtros"]) =>
    filtros.every(([coluna, op, valor]) =>
      op === "eq" ? l[coluna] === valor : String(l[coluna]) > String(valor),
    );
  const copia = (l: Linha) => ({ ...l });

  const admin = {
    from(tabela: string): Construtor {
      const chamada: Chamada = { tabela, op: "select", filtros: [] };
      let limite: number | undefined;
      let inicioDaFaixa = 0;
      let ordem: string | undefined;

      const executar = (): Resultado => {
        if (opts.lanca) throw new Error("conexão caiu");
        if (opts.falha) return { data: null, error: opts.falha };
        const linhas = linhasDe(tabela);

        if (chamada.op === "insert") {
          const nova = chamada.linha ?? {};
          const unico = opts.unicos?.[tabela];
          if (
            unico &&
            unico.quando(nova) &&
            linhas.some((l) => unico.quando(l) && unico.colunas.every((c) => l[c] === nova[c]))
          ) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          sequencia += 1;
          const gravada = { id: `linha-${sequencia}`, ...nova };
          linhas.push(gravada);
          return { data: [copia(gravada)], error: null };
        }

        if (chamada.op === "update") {
          const alvo = linhas.filter((l) => casa(l, chamada.filtros));
          for (const l of alvo) Object.assign(l, chamada.patch ?? {});
          return { data: alvo.map(copia), error: null };
        }

        let achados = linhas.filter((l) => casa(l, chamada.filtros));
        const coluna = ordem;
        if (coluna) achados = [...achados].sort((a, b) => String(a[coluna]).localeCompare(String(b[coluna])));
        if (limite !== undefined) achados = achados.slice(inicioDaFaixa, inicioDaFaixa + limite);
        return { data: achados.map(copia), error: null };
      };

      const construtor: Construtor = {
        select() {
          return construtor;
        },
        eq(coluna, valor) {
          chamada.filtros.push([coluna, "eq", valor]);
          return construtor;
        },
        gt(coluna, valor) {
          chamada.filtros.push([coluna, "gt", valor]);
          return construtor;
        },
        order(coluna) {
          // Só a 1ª ordenação conta: a 2ª (`id`) é desempate, e aqui não há empate.
          if (ordem === undefined) ordem = coluna;
          return construtor;
        },
        range(de, ate) {
          inicioDaFaixa = de;
          limite = ate - de + 1;
          return construtor;
        },
        limit(n) {
          limite = n;
          return construtor;
        },
        insert(linha) {
          chamada.op = "insert";
          chamada.linha = linha;
          return construtor;
        },
        update(patch) {
          chamada.op = "update";
          chamada.patch = patch;
          return construtor;
        },
        then(ok, ko) {
          // Quem `await`a o construtor executa a consulta: a chamada entra no registro
          // no momento em que o código a dispara, como no cliente real.
          chamadas.push({ ...chamada, filtros: [...chamada.filtros] });
          let resultado: Resultado;
          try {
            resultado = executar();
          } catch (err) {
            return Promise.reject(err).then(ok as never, ko as never) as never;
          }
          return Promise.resolve(resultado).then(ok as never, ko as never) as never;
        },
      };
      return construtor;
    },
  };

  return {
    admin: admin as unknown as SupabaseClient,
    chamadas,
    tabela: (nome: string) => linhasDe(nome),
  };
}

/** O índice único parcial do resumo e o do aviso de cliente, como a migration 9033 os cria. */
const UNICOS = {
  agent_inbox_items: {
    colunas: ["organization_id", "kind", "ref_id"],
    quando: (l: Linha) => l.status === "open",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resumo da recuperação: um aberto por conexão", () => {
  it("a primeira chamada insere; a segunda, com o índice recusando, ATUALIZA o aberto", async () => {
    const fake = fakeAdmin({ tabelas: {}, unicos: UNICOS });
    const args = {
      organizationId: ORG,
      channelSessionId: CANAL,
      motivo: "concluida" as const,
      conversas: 2,
      desde: "2026-10-27T10:00:00.000Z",
      ate: "2026-10-27T13:00:00.000Z",
    };

    await avisarResumoDaRecuperacao(fake.admin, { ...args, mensagens: 5 });
    await avisarResumoDaRecuperacao(fake.admin, { ...args, mensagens: 9, conversas: 4 });

    // Um aberto só, com o texto da segunda queda: não se empilha um aviso novo.
    const abertos = fake.tabela("agent_inbox_items").filter((l) => l.kind === "recuperacao_da_queda");
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.body).toContain("Recuperamos 9 mensagens de 4 conversas");
    // A segunda tentativa de INSERT foi feita e recusada; o update é que fez o trabalho.
    const inserts = fake.chamadas.filter((c) => c.op === "insert");
    const updates = fake.chamadas.filter((c) => c.op === "update");
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(1);
    // E o update procura o aberto desta conexão, da mesma organização.
    expect(updates[0]!.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "eq", ORG],
        ["kind", "eq", "recuperacao_da_queda"],
        ["ref_id", "eq", CANAL],
        ["status", "eq", "open"],
      ]),
    );
    // Sabotagem: tirar o tratamento do 23505 (o `if (error.code !== "23505")` virando
    // um `return` sem update) deixa o corpo com 5 mensagens e este teste fica vermelho.
  });

  it("fechar o resumo resolve só o aberto desta conexão, com a data de resolução", async () => {
    const fake = fakeAdmin({
      tabelas: {
        agent_inbox_items: [
          { id: "r-1", organization_id: ORG, kind: "recuperacao_da_queda", ref_id: CANAL, status: "open" },
          { id: "r-2", organization_id: ORG, kind: "recuperacao_da_queda", ref_id: "outra-conexao", status: "open" },
        ],
      },
      unicos: UNICOS,
    });

    await fecharResumoDaRecuperacao(fake.admin, { organizationId: ORG, channelSessionId: CANAL });

    const linhas = fake.tabela("agent_inbox_items");
    expect(linhas.find((l) => l.id === "r-1")).toMatchObject({ status: "resolved" });
    expect(linhas.find((l) => l.id === "r-1")!.resolved_at).toEqual(expect.any(String));
    expect(linhas.find((l) => l.id === "r-2")).toMatchObject({ status: "open" });
    // Sabotagem: tirar `.eq("ref_id", channelSessionId)` fecha também a conexão vizinha e este teste fica vermelho.
  });
});

describe("texto do resumo, por motivo", () => {
  async function corpoDe(motivo: MotivoDoResumo, extra: Partial<Parameters<typeof avisarResumoDaRecuperacao>[1]> = {}) {
    const fake = fakeAdmin({ unicos: UNICOS });
    await avisarResumoDaRecuperacao(fake.admin, {
      organizationId: ORG,
      channelSessionId: CANAL,
      motivo,
      ...extra,
    });
    return fake.tabela("agent_inbox_items")[0];
  }

  it("concluída: recuperadas, conversas e o período no fuso da instalação", async () => {
    const linha = await corpoDe("concluida", {
      mensagens: 12,
      conversas: 3,
      desde: "2026-10-27T10:00:00.000Z",
      ate: "2026-10-28T10:00:00.000Z",
    });
    // 10:00 UTC é 07:00 em São Paulo (UTC-3): o período sai no horário de quem opera.
    // O separador entre data e hora varia por build do ICU (vírgula, espaço ou espaço fino): aceita qualquer um.
    expect(linha!.body).toMatch(
      /^Recuperamos 12 mensagens de 3 conversas do período em que o número ficou fora \(27\/10\/\d{2,4}[,\s  ]+07:00 a 28\/10\/\d{2,4}[,\s  ]+07:00\)\.$/,
    );
    expect(linha!.title).toBe("Conversas da queda recuperadas");
    // Sabotagem: trocar a data por ISO cru (sem formatar) deixa a expressão acima sem casar.
  });

  it("erro: diz que parou, com o motivo resumido e o atalho para Conexões", async () => {
    const linha = await corpoDe("erro", { erro: "canal desconectado no meio da leitura" });
    expect(linha!.body).toBe(
      "A recuperação das conversas da queda parou: canal desconectado no meio da leitura. Veja em Conexões.",
    );
    expect(linha!.title).toBe("A recuperação das conversas da queda parou");
    // Sabotagem: apagar o trecho "Veja em Conexões." tira o caminho para a tela e este teste fica vermelho.
  });

  it("número mudou: diz o motivo e que não trouxe o outro aparelho", async () => {
    const linha = await corpoDe("numero_mudou");
    expect(linha!.body).toBe(
      "O número da conexão mudou na reconexão. As conversas do período fora do ar não foram recuperadas, para não trazer mensagens de outro aparelho.",
    );
    // Sabotagem: trocar o motivo por "recuperação concluída" faz a expressão exata deixar de casar.
  });

  it("número não confirmado: diz que não conseguimos confirmar o número", async () => {
    const linha = await corpoDe("numero_nao_confirmado");
    expect(linha!.body).toBe(
      "Não conseguimos confirmar o número da conexão depois da volta. As conversas do período fora do ar não foram recuperadas.",
    );
    // Sabotagem: usar o texto de "número mudou" no lugar deste faz o teste ficar vermelho.
  });

  it("histórico desligado: nomeia o botão \"Guardar o histórico\"", async () => {
    const linha = await corpoDe("acervo_desligado");
    expect(linha!.body).toBe(
      "A conexão voltou, mas \"Guardar o histórico\" está desligado nela: não há como recuperar as conversas do período fora do ar.",
    );
    // Sabotagem: remover as aspas do nome do botão deixa o texto diferente e este teste fica vermelho.
  });

  it("concluída sem nenhuma mensagem não cria aviso: não há o que o administrador precise agir", async () => {
    const fake = fakeAdmin({ unicos: UNICOS });
    await avisarResumoDaRecuperacao(fake.admin, {
      organizationId: ORG,
      channelSessionId: CANAL,
      motivo: "concluida",
      mensagens: 0,
      conversas: 0,
    });
    expect(fake.chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
    // Sabotagem: tirar a guarda `mensagens > 0` faz nascer um aviso vazio e este teste fica vermelho.
  });
});

describe("aviso de cliente sem resposta", () => {
  it("o 23505 (o aviso já existe) não lança e não gera log de erro", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fake = fakeAdmin({ unicos: UNICOS });
    const args = { organizationId: ORG, conversationId: CONVERSA_A, contactId: CONTATO };

    await expect(avisarClienteSemResposta(fake.admin, args)).resolves.toBeUndefined();
    await expect(avisarClienteSemResposta(fake.admin, args)).resolves.toBeUndefined();

    const abertos = fake.tabela("agent_inbox_items").filter((l) => l.kind === "cliente_sem_resposta_na_queda");
    expect(abertos).toHaveLength(1);
    expect(abertos[0]).toMatchObject({ ref_kind: "conversation", ref_id: CONVERSA_A, status: "open" });
    // A segunda chamada é o caso normal (duas passadas da recuperação): não é erro, não polui o log.
    expect(aviso).not.toHaveBeenCalled();
    // Sabotagem: tratar o 23505 como erro (chamar logger.warn sempre que `error` vier) deixa `not.toHaveBeenCalled` vermelho.
  });
});

describe("fechar os avisos de cliente que já foram respondidos", () => {
  it("resposta DEPOIS do aviso fecha; resposta ANTES dele não fecha; sempre filtrando a organização", async () => {
    const abertoEm = "2026-10-27T10:00:00.000Z";
    const fake = fakeAdmin({
      tabelas: {
        agent_inbox_items: [
          { id: "aviso-a", organization_id: ORG, kind: "cliente_sem_resposta_na_queda", ref_id: CONVERSA_A, status: "open", created_at: abertoEm },
          { id: "aviso-b", organization_id: ORG, kind: "cliente_sem_resposta_na_queda", ref_id: CONVERSA_B, status: "open", created_at: abertoEm },
          // Aviso de OUTRA organização com a mesma forma: nunca pode ser tocado daqui.
          { id: "aviso-x", organization_id: OUTRA_ORG, kind: "cliente_sem_resposta_na_queda", ref_id: CONVERSA_A, status: "open", created_at: abertoEm },
        ],
        messages: [
          // A conversa A teve saída da equipe às 11:00: depois do aviso, fecha.
          { id: "m-1", organization_id: ORG, conversation_id: CONVERSA_A, direction: "outbound", created_at: "2026-10-27T11:00:00.000Z" },
          // A conversa B teve saída só às 09:00, ANTES do aviso: não fecha.
          { id: "m-2", organization_id: ORG, conversation_id: CONVERSA_B, direction: "outbound", created_at: "2026-10-27T09:00:00.000Z" },
          // Uma saída da OUTRA organização na conversa B, depois do aviso: se o filtro de
          // organização faltasse na consulta de mensagens, esta fecharia o aviso-b por engano.
          { id: "m-3", organization_id: OUTRA_ORG, conversation_id: CONVERSA_B, direction: "outbound", created_at: "2026-10-27T12:00:00.000Z" },
        ],
      },
      unicos: UNICOS,
    });

    const fechados = await fecharAvisosDeClienteRespondido(fake.admin, ORG);

    expect(fechados).toBe(1);
    const linhas = fake.tabela("agent_inbox_items");
    expect(linhas.find((l) => l.id === "aviso-a")).toMatchObject({ status: "resolved" });
    expect(linhas.find((l) => l.id === "aviso-b")).toMatchObject({ status: "open" });
    expect(linhas.find((l) => l.id === "aviso-x")).toMatchObject({ status: "open" });

    // Toda consulta às duas tabelas leva organization_id, e a da mensagem compara com o created_at do aviso.
    const consultas = fake.chamadas.filter((c) => c.op === "select");
    expect(consultas.length).toBeGreaterThan(0);
    for (const c of consultas) {
      expect(c.filtros).toContainEqual(["organization_id", "eq", ORG]);
    }
    const consultaDeMensagens = consultas.filter((c) => c.tabela === "messages");
    expect(consultaDeMensagens.length).toBeGreaterThan(0);
    for (const c of consultaDeMensagens) {
      expect(c.filtros).toContainEqual(["created_at", "gt", abertoEm]);
    }
    // Sabotagem: comparar sem o created_at do aviso (tirar o `.gt("created_at", ...)`)
    // faz a resposta de antes da queda fechar o aviso-b, e este teste fica vermelho.
  });
});

describe("falha de gravação não lança", () => {
  it("erro do banco em qualquer das quatro funções: resolve, registra em log e devolve 0 onde há contagem", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fake = fakeAdmin({ falha: { code: "42501", message: "permission denied" }, unicos: UNICOS });
    const args = { organizationId: ORG, channelSessionId: CANAL, conversationId: CONVERSA_A, contactId: CONTATO };

    await expect(
      avisarResumoDaRecuperacao(fake.admin, { ...args, motivo: "erro", erro: "x" }),
    ).resolves.toBeUndefined();
    await expect(fecharResumoDaRecuperacao(fake.admin, args)).resolves.toBeUndefined();
    await expect(avisarClienteSemResposta(fake.admin, args)).resolves.toBeUndefined();
    await expect(fecharAvisosDeClienteRespondido(fake.admin, ORG)).resolves.toBe(0);

    expect(aviso).toHaveBeenCalled();
    // Sabotagem: deixar uma das quatro sem o try/catch (ou sem o registro do erro) faz o `resolves` correspondente falhar.
  });

  it("exceção no meio da chamada (a conexão caiu) também não lança", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fake = fakeAdmin({ lanca: true, unicos: UNICOS });
    const args = { organizationId: ORG, channelSessionId: CANAL, conversationId: CONVERSA_A, contactId: CONTATO };

    await expect(
      avisarResumoDaRecuperacao(fake.admin, { ...args, motivo: "numero_mudou" }),
    ).resolves.toBeUndefined();
    await expect(avisarClienteSemResposta(fake.admin, args)).resolves.toBeUndefined();
    await expect(fecharAvisosDeClienteRespondido(fake.admin, ORG)).resolves.toBe(0);
    expect(aviso).toHaveBeenCalled();
    // Sabotagem: tirar o catch de uma função faz o `resolves` rejeitar e este teste fica vermelho.
  });
});
