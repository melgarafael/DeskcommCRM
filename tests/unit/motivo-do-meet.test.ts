import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoMeet, semSegredos } from "@/lib/agenda/motivo-do-meet";

/**
 * "Enviar link ao cliente": 20 segundos parado e "Erro inesperado".
 *
 * Medido numa instalação real em 2026-09-12, e depois reproduzido chamando
 * `fn_meet_action` direto no banco, com a conta real e os dados reais do
 * compromisso. O banco responde:
 *
 *     ERROR: meet_conversation_stale
 *
 * — o atendimento daquela conversa mudou depois que o link foi criado. Recusa
 * legítima, específica, e que o banco sabia dizer desde o primeiro
 * milissegundo.
 *
 * O que a rota fazia com isso: reconhecia só dois SQLSTATE, caía no genérico
 * **500**, e 500 é status de "tente de novo" — então o cliente repetia três
 * vezes. Os 20 segundos que o operador cronometrou eram as três tentativas.
 *
 * E o registro no servidor gravava `code: "internal_error"`, texto fixo no
 * código: o servidor sabia o motivo e o apagava ao registrá-lo. Por isso um dia
 * inteiro de investigação não achou nada nos logs.
 */

describe("o motivo da recusa chega inteiro à tela", () => {
  it("⛔ `meet_conversation_stale` — o caso medido em produção", () => {
    const m = motivoDoMeet({ message: "meet_conversation_stale" });
    expect(m.codigo).toBe("meet_conversation_stale");
    expect(m.texto).toMatch(/atendimento desta conversa mudou/i);
  });

  it("⛔ e ele NÃO volta como 5xx — é isto que acaba com os 20 segundos", () => {
    // O cliente repete automaticamente em 5xx. Uma recusa de regra devolvida
    // como 500 vira três tentativas idênticas e três recusas idênticas.
    const m = motivoDoMeet({ message: "meet_conversation_stale" });
    expect(m.status).toBe(409);
    expect(m.status).toBeLessThan(500);
    expect(m.naoRepetir).toBe(true);
  });

  it("⛔ `meet_stale` NÃO é confundido com `meet_conversation_stale`", () => {
    // Um é substring do outro. Sem limite de palavra, a ordem das chaves
    // decidiria qual vence — e a pessoa leria "atualize a página" quando o
    // certo é "escolha a conversa atual". Duas ações diferentes, uma delas
    // inútil.
    expect(motivoDoMeet({ message: "meet_stale" }).codigo).toBe("meet_stale");
    expect(motivoDoMeet({ message: "meet_conversation_stale" }).codigo).toBe(
      "meet_conversation_stale",
    );
  });

  it("os três motivos de `42501` param de virar a MESMA frase", () => {
    // O SQLSTATE 42501 cobre "não é o responsável", "falta verificação em duas
    // etapas" e "a conversa não serve". Traduzir pelo SQLSTATE obrigava a dizer
    // as três de uma vez — e a frase resultante não mencionava verificação
    // nenhuma, mandando a pessoa mexer onde talvez não fosse.
    const frases = [
      motivoDoMeet({ message: "meet_forbidden" }).texto,
      motivoDoMeet({ message: "meet_mfa_required" }).texto,
      motivoDoMeet({ message: "meet_conversation_unavailable" }).texto,
    ];
    expect(new Set(frases).size).toBe(3);
    expect(frases[1]).toMatch(/duas etapas/i);
  });

  it("lê o motivo também quando ele vem dentro de uma mensagem maior", () => {
    // O erro chega pelo PostgREST embrulhado; o nome aparece no meio do texto.
    const m = motivoDoMeet({
      message: 'erro ao executar RPC: meet_conversation_stale (PL/pgSQL linha 28)',
    });
    expect(m.codigo).toBe("meet_conversation_stale");
  });

  it("cai no SQLSTATE quando o nome não vem — degrau que já existia", () => {
    expect(motivoDoMeet({ code: "40001" }).status).toBe(409);
    expect(motivoDoMeet({ code: "42501" }).status).toBe(403);
  });

  it("CONTROLE: erro DESCONHECIDO continua 500 e continua repetindo", () => {
    // Este é o caso em espelho, e ele é o que impede o conserto de virar um
    // defeito novo: falha de rede ou de infraestrutura MERECE nova tentativa.
    // Marcar tudo como "não repita" faria o sistema desistir de um problema
    // passageiro que se resolveria sozinho na segunda tentativa.
    for (const estranho of [{}, { message: "connection reset" }, null, undefined, "texto"]) {
      const m = motivoDoMeet(estranho);
      expect(m.codigo).toBe("internal_error");
      expect(m.status).toBe(500);
      expect(m.naoRepetir).toBe(false);
    }
  });

  it("todo motivo conhecido tem frase própria — senão o conserto é aparência", () => {
    const nomes = [
      "meet_conversation_stale",
      "meet_stale",
      "google_conflict_requires_choice",
      "meet_conversation_unavailable",
      "meet_mfa_required",
      "meet_forbidden",
      "meet_action_invalid",
    ];
    const frases = nomes.map((n) => motivoDoMeet({ message: n }).texto);
    expect(new Set(frases).size).toBe(nomes.length);
  });
});

describe("o motivo vai para o log SEM segredo, mas vai", () => {
  it("⛔ o link da reunião não sobrevive à redação", () => {
    expect(semSegredos("falhou em https://meet.google.com/secret?token=private ao gravar")).toBe(
      "falhou em [link] ao gravar",
    );
  });

  it("⛔ e nenhum outro endereço também — o segredo pode estar na query", () => {
    expect(semSegredos("POST https://api.exemplo.com/x?key=abc 500")).toBe("POST [link] 500");
  });

  it("o resto da frase SOBREVIVE — é ele que permite diagnosticar", () => {
    // Esta é a metade que faltava. A versão anterior apagava a mensagem
    // INTEIRA, e um erro real de produção (`sqlstate: undefined`, sem nome
    // conhecido) ficou sem nenhuma pista: o servidor sabia o que tinha
    // acontecido e não guardava nada além do código genérico.
    expect(semSegredos("fetch failed: ECONNREFUSED")).toBe("fetch failed: ECONNREFUSED");
  });

  it("erro sem mensagem não vira a string 'undefined'", () => {
    expect(semSegredos(undefined)).toBe(null);
    expect(semSegredos("")).toBe(null);
  });

  it("CONTROLE: a redação não é vacuidade — texto sem link passa inteiro", () => {
    const frase = "meet_conversation_stale (PL/pgSQL linha 28)";
    expect(semSegredos(frase)).toBe(frase);
  });
});

describe("a rota não volta a apagar o motivo ao registrar", () => {
  const ROTA = path.join(
    process.cwd(),
    "app",
    "api",
    "v1",
    "agenda",
    "agendamentos",
    "[id]",
    "google",
    "meet",
    "_action.ts",
  );
  /**
   * ⚠️ SEM OS COMENTÁRIOS.
   *
   * A primeira versão desta cerca leu o arquivo inteiro e reprovou — por causa
   * do comentário que EXPLICA o defeito, escrito três linhas acima do conserto.
   * É a armadilha conhecida da cerca por texto: a prosa cita a forma proibida
   * para ensinar, e a cerca não sabe distinguir ensinar de cometer.
   *
   * Apagar a explicação para o teste passar seria a troca errada — o comentário
   * é o que impede alguém de reintroduzir o defeito por não saber que existiu.
   */
  const fonte = fs
    .readFileSync(ROTA, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it('⛔ nenhum `code: "internal_error"` fixo no registro', () => {
    // A linha exata que escondeu o defeito por um dia inteiro:
    //   logger.error("agenda.meet_action_failed", { requestId, action, code: "internal_error" })
    // O servidor sabia o motivo e gravava uma constante no lugar dele.
    expect(/code:\s*"internal_error"/.test(fonte), "há um código fixo no registro").toBe(false);
  });

  it("⛔ registra o MOTIVO derivado e o SQLSTATE", () => {
    expect(fonte).toMatch(/code:\s*motivo\.codigo/);
    expect(fonte).toMatch(/sqlstate:/);
  });

  it("⛔ e NUNCA a mensagem crua — ela pode carregar o LINK DA REUNIÃO", () => {
    // ⚠️ ESTA CERCA PEDIA O CONTRÁRIO, e pedir o contrário era o defeito.
    //
    // Ela dizia `expect(fonte).toMatch(/erro:/)` — cobrando que a mensagem do
    // erro fosse registrada. `tests/unit/agenda-meet-routes.test.ts` injeta
    // `https://meet.google.com/secret?token=private` como mensagem e exige que
    // o registro não contenha "secret": os dois arquivos se contradiziam, e
    // quem estava certo era o outro.
    //
    // O que torna o engano fácil de cometer: o `code: "internal_error"` fixo da
    // versão original NÃO era descuido, era sanitização. Ao consertar o campo
    // fixo — que apagava o motivo de TODO erro — a tentação é gravar a mensagem
    // inteira "para não perder nada". O certo é gravar o `codigo` derivado, que
    // é identificador nosso e não carrega dado de ninguém.
    // ⚠️ A regra mudou de "nao registre a mensagem" para "registre REDIGIDA".
    // Apagar a mensagem inteira custou um diagnostico real: um erro de
    // producao com `sqlstate: undefined` e nenhum nome conhecido nao deixou
    // pista nenhuma. Sanitizar demais tambem e um defeito.
    expect(fonte).toMatch(/mensagem:\s*semSegredos\(/);
    expect(/mensagem:\s*error\.message/.test(fonte), "mensagem crua no log").toBe(false);
    expect(/erro:\s*error instanceof Error/.test(fonte), "mensagem crua no log").toBe(false);
  });

  it("CONTROLE: esta cerca casa com a forma proibida em código de verdade", () => {
    // Sem isto, uma expressão que parasse de casar deixaria o caso acima verde
    // para sempre — inclusive com o vazamento de volta.
    expect(/error\.message/.test("{ erro: error.message }")).toBe(true);
  });

  it("CONTROLE: a cerca casa com a forma proibida em código de verdade", () => {
    // Guarda de vacuidade: se a expressão parasse de casar com qualquer coisa,
    // o caso de cima ficaria verde para sempre — inclusive com o defeito de volta.
    expect(/code:\s*"internal_error"/.test('{ code: "internal_error" }')).toBe(true);
  });

  it("CONTROLE: e a limpeza NÃO come código de verdade junto com o comentário", () => {
    // O risco do conserto acima: uma limpeza gulosa apagaria o próprio código
    // que precisa ser vigiado, e a cerca ficaria verde por não ter o que ler.
    expect(fonte).toMatch(/logger\.error\(/);
    expect(fonte).toMatch(/motivoDoMeet\(/);
  });
});
