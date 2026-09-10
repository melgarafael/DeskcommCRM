import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  esquecerModoDeCadastro,
  gravarModoDeCadastro,
  invalidarModoDeCadastro,
  modoDeCadastro,
} from "@/lib/auth/politica-de-cadastro";

/**
 * A política de cadastro da INSTALAÇÃO.
 *
 * O caso que este arquivo existe para vigiar é o 4: uma instalação FECHADA não
 * pode reabrir sozinha porque o banco soluçou. É a única propriedade aqui que
 * é de segurança — as outras são conforto.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// `env` é objeto congelado no módulo real; aqui ele é mutável para os casos do
// piso declarado no `.env`.
vi.mock("@/lib/env", () => ({ env: { SIGNUP_MODE: "" } }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

type Resposta = { data: unknown; error: { code?: string; message: string } | null };

/** Conta as idas ao banco — é como se prova o memo sem espiar o `globalThis`. */
let idas = 0;

function bancoQue(...respostas: Resposta[]) {
  idas = 0;
  const maybeSingle = vi.fn(async () => {
    const r = respostas[Math.min(idas, respostas.length - 1)]!;
    idas += 1;
    return r;
  });
  const upsert = vi.fn(async () => ({ error: null }));
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      upsert,
    }),
  } as never);
  return { upsert };
}

const ok = (modo: string | null): Resposta => ({
  data: modo === null ? null : { signup_mode: modo },
  error: null,
});
const falha = (code: string): Resposta => ({ data: null, error: { code, message: code } });

function declararNoEnv(valor: string) {
  (env as unknown as { SIGNUP_MODE: string }).SIGNUP_MODE = valor;
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerModoDeCadastro();
  declararNoEnv("");
});

describe("modoDeCadastro", () => {
  it("sem linha na tabela vale 'aberto' — o comportamento anterior à 0232", async () => {
    bancoQue(ok(null));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });

  it("lê 'so_convite' quando é o que está gravado", async () => {
    bancoQue(ok("so_convite"));
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });

  it("tabela inexistente (42P01) vale 'aberto': quem não aplicou a migration não é fechado", async () => {
    bancoQue(falha("42P01"));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });

  it("uma instalação FECHADA continua fechada quando o banco para de responder", async () => {
    // Este é o caso de segurança. Se a leitura caísse no default a cada falha,
    // um soluço do banco reabriria o cadastro de uma instalação que foi
    // deliberadamente fechada — e ninguém veria acontecer.
    bancoQue(ok("so_convite"), falha("57P01"));
    await expect(modoDeCadastro()).resolves.toBe("so_convite");

    invalidarModoDeCadastro();
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
    expect(idas).toBe(2);
  });

  it("valor fora do vocabulário não vira 'aberto' por acidente", async () => {
    // Só acontece se alguém dropar o CHECK e editar a coluna à mão. A leitura
    // honesta é "não sei", que cai no último conhecido — aqui, o fechado.
    bancoQue(ok("so_convite"), ok("qualquer_coisa"));
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
    invalidarModoDeCadastro();
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });

  it("memoriza: duas leituras seguidas batem no banco uma vez só", async () => {
    bancoQue(ok("so_convite"));
    await modoDeCadastro();
    await modoDeCadastro();
    expect(idas).toBe(1);
  });

  it("invalidar força a próxima leitura a ir ao banco", async () => {
    bancoQue(ok("aberto"), ok("so_convite"));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
    invalidarModoDeCadastro();
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
    expect(idas).toBe(2);
  });

  it("nunca lança — é chamada no caminho de renderizar /signup", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("sem conexão");
    });
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });
});

describe("SIGNUP_MODE — o piso declarado no .env", () => {
  it("sem linha no banco, o piso declarado é o que vale", async () => {
    declararNoEnv("so_convite");
    bancoQue(ok(null));
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });

  it("banco mudo e sem memória (app recém-subido) continua fechado", async () => {
    // Esta é a razão de a variável existir. A memória do último valor lido morre
    // com o processo; um reinício com o banco fora do ar não tem o que lembrar,
    // e sem o piso a instalação abriria justamente na janela cega.
    declararNoEnv("so_convite");
    bancoQue(falha("57P01"));
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });

  it("O BANCO ESTÁ ACIMA DO .env: linha 'aberto' vence piso 'so_convite'", async () => {
    declararNoEnv("so_convite");
    bancoQue(ok("aberto"));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });

  it("valor irreconhecível NÃO fecha a instalação por engano", async () => {
    // Um `SIGNUP_MODE=aberot` digitado errado não pode trancar a porta de quem
    // nunca pediu para trancar. Quem exige o fechamento tem o mecanismo
    // primário, que é a linha no banco.
    declararNoEnv("aberot");
    bancoQue(ok(null));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });

  it("vazio é o padrão do produto — instalação que não declarou nada segue aberta", async () => {
    bancoQue(ok(null));
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });
});

describe("gravarModoDeCadastro", () => {
  it("grava e invalida o memo, para a próxima leitura ver o novo valor", async () => {
    const { upsert } = bancoQue(ok("aberto"), ok("so_convite"));
    await expect(modoDeCadastro()).resolves.toBe("aberto");

    await expect(gravarModoDeCadastro("so_convite", "u1")).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      { id: 1, signup_mode: "so_convite", updated_by: "u1" },
      { onConflict: "id" },
    );
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });

  it("devolve false quando o banco recusa — quem chama mostra isso na tela", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({ upsert: async () => ({ error: { code: "42501", message: "denied" } }) }),
    } as never);
    await expect(gravarModoDeCadastro("so_convite", "u1")).resolves.toBe(false);
  });

  it("não lança quando a conexão explode", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("sem conexão");
    });
    await expect(gravarModoDeCadastro("aberto", "u1")).resolves.toBe(false);
  });
});
