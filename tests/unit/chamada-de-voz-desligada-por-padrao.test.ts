/**
 * A CHAMADA DE VOZ NASCE DESLIGADA, E "DESLIGAR" DESCONECTA DE VERDADE.
 *
 * ## As duas condições do dono do produto, e o que cada uma cobra
 *
 * 1. **"o número não deve ser exposto"** — ninguém ganha um segundo aparelho
 *    vinculado ao número por atualizar o sistema. Aqui isso vira: ausência de
 *    linha é DESLIGADO, e a capacidade da instalação não liga a feature de
 *    ninguém.
 * 2. **"nada pode entrar provisório… com opção real de desligar"** — o
 *    interruptor não pode ser um rótulo. Desligar tem de chamar `logout` e
 *    `delete` no serviço, na ordem certa, e só depois mexer no banco.
 *
 * ## Por que testes de FUNÇÃO PURA e de ATO, e não de rota
 *
 * A regra inteira do item 1 cabe numa linha (`instalacaoOferece && (escolha ??
 * false)`), e é essa linha que decide se a tela grava algo que o resto do
 * sistema honra. O item 2 é uma sequência de três passos cuja ORDEM é a
 * propriedade — e ordem se prova com um dublê que registra a sequência, não com
 * um mock que confirma que a função foi chamada.
 */
import { describe, expect, it, vi } from "vitest";

import { despareaVoz } from "@/lib/voice/desparear";
import type { WacallsClient } from "@/lib/wacalls/client";
import {
  chamadaDeVozLigada,
  estadoDaVoz,
  instalacaoOfereceVoz,
} from "@/lib/voice/opt-in";

describe("chamadaDeVozLigada — capacidade E consentimento, nunca um ou outro", () => {
  it("sem escolha da organização, fica DESLIGADA mesmo com o serviço de pé", () => {
    // O coração da condição do dono. Se isto virasse `escolha ?? padrao` — a
    // precedência que `lib/agent-engine/guardrails/camadas-da-org.ts` usa —,
    // ligar o serviço na VPS entregaria a capacidade a TODAS as organizações da
    // instalação de uma vez, sem ninguém ter sido perguntado.
    expect(chamadaDeVozLigada(null, true)).toBe(false);
  });

  it("a organização não liga o que a instalação não oferece", () => {
    // A outra direção: consentimento gravado não fabrica um serviço. Sem isto,
    // a tela mostraria "ligada" e o pareamento devolveria 503.
    expect(chamadaDeVozLigada(true, false)).toBe(false);
  });

  it("ligada exige as DUAS pontas", () => {
    expect(chamadaDeVozLigada(true, true)).toBe(true);
  });

  it("desligar explicitamente não se confunde com nunca ter escolhido", () => {
    // Os dois dão `false` hoje, e é por isso que a distinção precisa de
    // asserção própria: o `motivo` é o que a tela usa para dizer a frase certa,
    // e um colapso em booleano apagaria essa diferença sem quebrar nada acima.
    expect(estadoDaVoz(false, true).motivo).toBe("organizacao_nao_ligou");
    expect(estadoDaVoz(null, true).motivo).toBe("organizacao_nao_ligou");
    expect(estadoDaVoz(true, false).motivo).toBe("instalacao_nao_oferece");
    expect(estadoDaVoz(true, true).motivo).toBe("ligada");
  });

  it("a instalação sem serviço vence a leitura do motivo", () => {
    // Ordem do `motivo`, e ela tem consequência de produto: dizer "você não
    // ligou" a quem está num servidor sem o serviço manda o admin clicar um
    // botão que não resolve nada.
    expect(estadoDaVoz(null, false).motivo).toBe("instalacao_nao_oferece");
  });

  it("`.env` sem a chave, vazio ou só com espaço não oferece a feature", () => {
    // O `.trim()` não é preciosismo: o install.sh grava a chave VAZIA, e um
    // `.env` editado à mão com um espaço sobrando ligaria a capacidade por
    // acidente — sem que ninguém tivesse escrito um endereço.
    expect(instalacaoOfereceVoz(undefined)).toBe(false);
    expect(instalacaoOfereceVoz("")).toBe(false);
    expect(instalacaoOfereceVoz("   ")).toBe(false);
    expect(instalacaoOfereceVoz("http://wacalls:8080")).toBe(true);
  });
});

/** Um Supabase de mentira que registra o que foi escrito na linha do canal. */
function supabaseFalso(linha: { id: string; wacalls_session_id: string | null } | null) {
  const escritas: Array<Record<string, unknown>> = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    is: () => cadeia,
    maybeSingle: async () => ({ data: linha, error: null }),
    update: (patch: Record<string, unknown>) => {
      escritas.push(patch);
      return { eq: () => ({ eq: async () => ({ error: null }) }) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: () => cadeia } as any, escritas };
}

/** Cliente de mentira que registra a SEQUÊNCIA — é a ordem que se está provando. */
function wacallsFalso(falhaEm?: "logout" | "delete") {
  const passos: string[] = [];
  const cliente = {
    logoutSession: async () => {
      passos.push("logout");
      if (falhaEm === "logout") throw new Error("wacalls_502: caiu");
    },
    deleteSession: async () => {
      passos.push("delete");
      if (falhaEm === "delete") throw new Error("wacalls_502: caiu");
    },
  } as unknown as WacallsClient;
  return { passos, cliente };
}

describe("despareaVoz — desligar não é esconder", () => {
  it("chama logout ANTES de delete, e só então arquiva a linha", async () => {
    const { db, escritas } = supabaseFalso({ id: "cs-1", wacalls_session_id: "wa-1" });
    const { cliente, passos } = wacallsFalso();

    const r = await despareaVoz(db, cliente, "org-1");

    // Presença antes de ordem: `indexOf` de algo que não foi chamado é -1, e
    // `-1 < 0` passaria alegremente num par que nunca aconteceu.
    expect(passos, "o logout não foi chamado").toContain("logout");
    expect(passos, "o delete não foi chamado").toContain("delete");
    expect(passos.indexOf("logout")).toBeLessThan(passos.indexOf("delete"));

    expect(r.desapareado).toBe(true);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toMatchObject({ status: "STOPPED", wacalls_session_id: null });
    expect(escritas[0]!.archived_at).toBeTruthy();
  });

  it("se o serviço falhar, a linha NÃO é arquivada", async () => {
    // A propriedade que separa "desligado" de "diz que desligou": arquivar
    // assim mesmo faria a tela anunciar que o aparelho saiu com ele ainda
    // vinculado do lado do WhatsApp — a mentira exata que a feature existe
    // para não contar.
    const { db, escritas } = supabaseFalso({ id: "cs-1", wacalls_session_id: "wa-1" });
    const { cliente } = wacallsFalso("logout");

    await expect(despareaVoz(db, cliente, "org-1")).rejects.toThrow();
    expect(escritas, "arquivou a linha mesmo com o aparelho vinculado").toEqual([]);
  });

  it("a falha no DELETE também segura o banco", async () => {
    // O irmão do caso acima. Cobrir só o primeiro passo daria a sensação de
    // classe fechada com metade do caminho aberto.
    const { db, escritas } = supabaseFalso({ id: "cs-1", wacalls_session_id: "wa-1" });
    const { cliente } = wacallsFalso("delete");

    await expect(despareaVoz(db, cliente, "org-1")).rejects.toThrow();
    expect(escritas).toEqual([]);
  });

  it("desparear o que nunca foi pareado é sucesso, não erro", async () => {
    // Idempotência: quem está tentando REDUZIR risco não pode topar com um erro
    // por já ter conseguido. Vale para o segundo clique e para quem desliga a
    // feature sem nunca ter pareado.
    const { db, escritas } = supabaseFalso(null);
    const { cliente, passos } = wacallsFalso();

    const r = await despareaVoz(db, cliente, "org-1");

    expect(r).toEqual({ desapareado: false, channelSessionId: null });
    expect(passos, "falou com o serviço sem ter o que desparear").toEqual([]);
    expect(escritas).toEqual([]);
  });
});

describe("o cliente do WaCalls fala com o upstream autenticado", () => {
  it("manda Authorization: Bearer em toda chamada", async () => {
    // Sem isto o serviço responde 401 em tudo: o upstream autenticado não tem
    // modo aberto, e um processo server-to-server não tem o cookie de login.
    const fetchFalso = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchFalso);

    const { WacallsClient } = await import("@/lib/wacalls/client");
    await new WacallsClient("http://wacalls:8080", "tok-123").listSessions().catch(() => {});

    expect(fetchFalso).toHaveBeenCalled();
    const init = fetchFalso.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    vi.unstubAllGlobals();
  });

  it("lê o histórico do envelope `calls`, não do `rows` do build sem autenticação", async () => {
    // Ler o campo errado devolve `undefined`, e um histórico vazio tem
    // exatamente a mesma cara de "esta organização não ligou para ninguém" —
    // por isso a asserção é sobre o conteúdo, não sobre não ter estourado.
    const fetchFalso = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ calls: [{ callId: "c1" }], nextCursor: "abc" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchFalso);

    const { WacallsClient } = await import("@/lib/wacalls/client");
    const out = await new WacallsClient("http://wacalls:8080", "tok").history("s1");

    expect(out.calls).toHaveLength(1);
    expect(out.nextCursor).toBe("abc");
    vi.unstubAllGlobals();
  });
});
