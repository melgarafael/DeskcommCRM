/**
 * O PORTÃO DO PISO OCIOSO (#3731, parte 1) — o que ele promete, medido.
 *
 * As três promessas, uma por teste:
 *
 * 1. UMA consulta responde pelos CINCO recursos (não uma por recurso).
 * 2. CEM ticks dentro da janela continuam sendo UMA consulta — o portão não pode
 *    virar a consulta por minuto que ele veio remover.
 * 3. Leitura que falha = "tem trabalho" (a rota segue), e a falha também fica em
 *    cache: um banco quebrado não pode transformar o portão em enxurrada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BancoDoPortao,
  esquecerRetrato,
  RECURSOS_DO_CRON,
  recursoOcioso,
  recursoTemTrabalho,
  TTL_DO_RETRATO_MS,
} from "./piso-ocioso";

type ConsultaDublada = (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;

/** Pool de mentira: conta consultas e devolve a linha que o teste mandar. */
function banco(linha: Record<string, unknown> = {}) {
  const consultas: string[] = [];
  const query = vi.fn<ConsultaDublada>(async (sql: string) => {
    consultas.push(sql);
    return { rows: [linha], rowCount: 1 };
  });
  // O `Pool["query"]` do pg é sobrecarregado (callback/evento); o portão só usa a
  // forma que devolve promessa, então o dublê entra como banco por este tipo.
  const portao = { query } as unknown as BancoDoPortao;
  return { consultas, query, portao };
}

const TUDO_VAZIO = {
  prospeccao: false,
  campanhas: false,
  historico: false,
  agenda_google: false,
  agenda_google_push: false,
};

beforeEach(() => {
  esquecerRetrato();
  vi.restoreAllMocks();
});

describe("portão do piso ocioso", () => {
  it("o sinal do histórico também olha a recuperação de queda (Spec 32), não só a importação rodando", async () => {
    // Sem isto a rota sairia antes de abrir a recuperação: uma queda do número numa
    // instalação sem importação alguma nunca recuperaria nada.
    const db = banco(TUDO_VAZIO);
    await recursoTemTrabalho("historico", 1_000, db.portao);
    const sql = (db.consultas[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain("importacoes_de_historico where status in ('rodando', 'aguardando')");
    expect(sql).toContain("event_type = 'channel_session.status_changed'");
    expect(sql).toContain("payload ->> 'from_status' = 'WORKING'");
    expect(sql).toContain("kind in ('recuperacao_da_queda', 'cliente_sem_resposta_na_queda')");
  });

  it("uma consulta responde pelos cinco recursos", async () => {
    const db = banco(TUDO_VAZIO);
    const respostas = await Promise.all(
      RECURSOS_DO_CRON.map((recurso) => recursoTemTrabalho(recurso, 1_000, db.portao)),
    );
    expect(respostas).toEqual([false, false, false, false, false]);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("cada coluna vira o recurso dela (controle positivo: nem tudo é falso)", async () => {
    const db = banco({
      prospeccao: true,
      campanhas: false,
      historico: true,
      agenda_google: false,
      agenda_google_push: true,
    });
    expect(await recursoTemTrabalho("prospeccao", 1_000, db.portao)).toBe(true);
    expect(await recursoTemTrabalho("historico", 1_000, db.portao)).toBe(true);
    expect(await recursoOcioso("campanhas", 1_000, db.portao)).toBe(true);
    expect(await recursoOcioso("agenda_google", 1_000, db.portao)).toBe(true);
    expect(await recursoTemTrabalho("agenda_google_push", 1_000, db.portao)).toBe(true);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("⭐ 100 ticks dentro da janela = 1 consulta (não é uma por minuto)", async () => {
    const db = banco(TUDO_VAZIO);
    // 100 ticks do cron de minuto a minuto, todos dentro do mesmo retrato.
    for (let tick = 0; tick < 100; tick++) {
      expect(await recursoOcioso("prospeccao", 1_000, db.portao)).toBe(true);
    }
    expect(db.query).toHaveBeenCalledOnce();

    // Passada a janela, o retrato é refeito UMA vez.
    await recursoTemTrabalho("prospeccao", 1_000 + TTL_DO_RETRATO_MS + 1, db.portao);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("leitura que falha = 'tem trabalho', e a falha fica em cache", async () => {
    const query = vi.fn<ConsultaDublada>(async () => {
      throw new Error("relation does not exist");
    });
    const portao = { query } as unknown as BancoDoPortao;
    for (let tick = 0; tick < 100; tick++) {
      expect(await recursoTemTrabalho("prospeccao", 1_000, portao)).toBe(true);
    }
    expect(query).toHaveBeenCalledOnce();
  });

  it("pool indisponível (sem SUPABASE_DB_URL) não derruba a rota: ela roda", async () => {
    // Sem `db`, o portão chama getRequestPool(), que lança sem a variável — o
    // caso do ambiente de teste. A rota tem de seguir o caminho normal.
    expect(await recursoTemTrabalho("historico")).toBe(true);
  });

  it("retrato velho não vale: quem ligou o recurso é atendido no tick seguinte à janela", async () => {
    const vazio = banco(TUDO_VAZIO);
    expect(await recursoTemTrabalho("campanhas", 1_000, vazio.portao)).toBe(false);

    const comCampanha = banco({ ...TUDO_VAZIO, campanhas: true });
    expect(
      await recursoTemTrabalho("campanhas", 1_000 + TTL_DO_RETRATO_MS + 1, comCampanha.portao),
    ).toBe(true);
  });

  it("⭐ campanha ligada logo depois de um retrato vazio: a batida do minuto seguinte já roda", async () => {
    // O crond dispara tudo no segundo 0. Retrato lido vazio em t=0, a pessoa
    // clica "Iniciar" em t=1 s, a batida seguinte chega em t=60 s. Com o TTL de
    // 5 min que este portão tinha, essa batida (e as três seguintes) PULAVA.
    const vazio = banco(TUDO_VAZIO);
    expect(await recursoOcioso("campanhas", 0, vazio.portao)).toBe(true);

    const comCampanha = banco({ ...TUDO_VAZIO, campanhas: true });
    expect(await recursoOcioso("campanhas", 60_000, comCampanha.portao)).toBe(false);
    expect(comCampanha.query).toHaveBeenCalledOnce();
  });
});
