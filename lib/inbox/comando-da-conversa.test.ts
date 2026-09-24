/**
 * Guarda de `comandoDaConversa` — a função que a tela usa para dizer quem manda.
 *
 * O que estes casos vigiam não é a aritmética: é o ESPELHO entre a tela e o
 * motor. Cada caso aqui corresponde a um gate que existe no código de produção,
 * e o teste do espelho (no fim) reprova quando o motor ganha um gate novo sem
 * que esta função aprenda a explicá-lo — que é exatamente o modo de falha que
 * fez a tela e o banco divergirem no vocabulário da timeline.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMANDOS_DO_BANCO,
  comandoDaConversa,
  comandosDaFila,
  ROTULO_DO_COMANDO,
  ROTULO_DO_MOTIVO,
  type FatosDoComando,
} from "./comando-da-conversa";

const AGORA = new Date("2026-08-24T12:00:00.000Z");
const ATENDENTE = "11111111-1111-4111-8111-111111111111";

function fatos(over: Partial<FatosDoComando> = {}): FatosDoComando {
  return { status: "open", assigned_to_user_id: null, ...over };
}

describe("comandoDaConversa — quem manda", () => {
  it("conversa aberta, sem dono e sem silêncio: o automático manda", () => {
    const r = comandoDaConversa(fatos(), AGORA);
    expect(r.comando).toEqual({ quem: "automatico" });
    expect(r.automaticoAtivo).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("com dono: a pessoa manda, e o nome vem junto quando o servidor o resolveu", () => {
    const r = comandoDaConversa(
      fatos({ assigned_to_user_id: ATENDENTE, assigned_to_user_name: "Maria Silva" }),
      AGORA,
    );
    expect(r.comando).toEqual({ quem: "humano", userId: ATENDENTE, nome: "Maria Silva" });
  });

  it("com dono e SEM nome resolvido: segue humano, com nome null — nunca some o dono", () => {
    // O degrade do lookup (sem service role) não pode virar "sem responsável":
    // seria uma afirmação sobre o atendimento feita em cima de falha de leitura.
    const r = comandoDaConversa(fatos({ assigned_to_user_id: ATENDENTE }), AGORA);
    expect(r.comando).toEqual({ quem: "humano", userId: ATENDENTE, nome: null });
  });

  it("sem dono e calado: é a fila — o automático saiu e ninguém pegou", () => {
    const r = comandoDaConversa(fatos({ status: "pending", bot_silenced_until: "infinity" }), AGORA);
    expect(r.comando).toEqual({ quem: "aguardando" });
    expect(r.automaticoAtivo).toBe(false);
    expect(r.motivo).toBe("pausado");
  });
});

describe("comandoDaConversa — o automático está ativo?", () => {
  it("'infinity' é silêncio DURÁVEL, não data inválida", () => {
    // `new Date("infinity")` é Invalid Date, e toda comparação com Invalid Date é
    // falsa: lido por engano, o silêncio para sempre leria como "já venceu".
    expect(Number.isNaN(new Date("infinity").getTime())).toBe(true);
    const r = comandoDaConversa(fatos({ bot_silenced_until: "infinity" }), AGORA);
    expect(r.automaticoAtivo).toBe(false);
  });

  it("silêncio no passado não cala nada", () => {
    const r = comandoDaConversa(
      fatos({ bot_silenced_until: "2026-08-24T11:55:00.000Z" }),
      AGORA,
    );
    expect(r.automaticoAtivo).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("silêncio finito no futuro sem dono: janela deslizante, e ela diz QUANDO volta", () => {
    const r = comandoDaConversa(
      fatos({ bot_silenced_until: "2026-08-24T12:04:00.000Z" }),
      AGORA,
    );
    expect(r.motivo).toBe("resposta_humana_recente");
    expect(r.silencioAte?.toISOString()).toBe("2026-08-24T12:04:00.000Z");
  });

  it("só 'resposta_humana_recente' traz o relógio — os outros motivos exigem alguém agir", () => {
    for (const f of [
      fatos({ bot_silenced_until: "infinity" }),
      fatos({ force_human: true }),
      fatos({ assigned_to_user_id: ATENDENTE, bot_silenced_until: "infinity" }),
    ]) {
      expect(comandoDaConversa(f, AGORA).silencioAte).toBeNull();
    }
  });

  it("force_human vence o silêncio local: o motivo nomeado é o do CONTATO", () => {
    // A ordem não é estética. Devolver o atendimento limpa a trava do CONTATO
    // inteiro; explicar o motivo MENOR faria a pessoa clicar esperando um efeito
    // menor do que o que vai acontecer.
    const r = comandoDaConversa(
      fatos({ force_human: true, bot_silenced_until: "infinity" }),
      AGORA,
    );
    expect(r.motivo).toBe("contato_travado");
  });

  it("dono + silêncio durável: o motivo é que alguém assumiu", () => {
    const r = comandoDaConversa(
      fatos({ status: "claimed", assigned_to_user_id: ATENDENTE, bot_silenced_until: "infinity" }),
      AGORA,
    );
    expect(r.motivo).toBe("atendente_no_comando");
  });

  it("silêncio durável sem dono: pausa genérica — a ação é devolver", () => {
    const r = comandoDaConversa(fatos({ bot_silenced_until: "infinity" }), AGORA);
    expect(r.motivo).toBe("pausado");
    expect(r.travaVigente).toBe(true);
  });

  it("C-075: pausa por resposta no CELULAR tem motivo próprio, e a trava é devolvível", () => {
    const r = comandoDaConversa(
      fatos({
        status: "claimed",
        bot_silenced_until: "infinity",
        last_handoff_reason: "Atendimento manual pelo canal (resposta fora do CRM)",
      }),
      AGORA,
    );
    expect(r.motivo).toBe("atendimento_pelo_celular");
    expect(r.travaVigente).toBe(true);
    expect(ROTULO_DO_MOTIVO.atendimento_pelo_celular).toMatch(/#on/i);
  });

  it("valor ilegível falha FECHADA: trata como calado, nunca afirma que está ativo", () => {
    const r = comandoDaConversa(fatos({ bot_silenced_until: "isto-nao-e-data" }), AGORA);
    expect(r.automaticoAtivo).toBe(false);
  });
});

describe("comandoDaConversa — conversa encerrada", () => {
  it.each(["closed", "archived"])("%s: comando é 'encerrada' e não há motivo de silêncio", (status) => {
    const r = comandoDaConversa(fatos({ status }), AGORA);
    expect(r.comando).toEqual({ quem: "encerrada" });
    expect(r.automaticoAtivo).toBe(false);
    // Encerrada não é silêncio: é ausência de assunto. Nomear um motivo aqui
    // faria a tela oferecer "devolver ao automático" como se houvesse algo a
    // retomar.
    expect(r.motivo).toBeNull();
  });

  it("encerrada COM dono NÃO apaga quem atendeu — ver o bloco 'o que a tela NÃO pode afirmar'", () => {
    const r = comandoDaConversa(
      fatos({ status: "closed", assigned_to_user_id: ATENDENTE, assigned_to_user_name: "Maria" }),
      AGORA,
    );
    expect(r.comando.quem).toBe("humano");
    expect(r.automaticoAtivo).toBe(false);
  });
});

describe("o que a tela NÃO pode afirmar", () => {
  it("org sem automático: conversa sem dono é 'ninguem', não 'automatico'", () => {
    // O defeito: a versão anterior dizia "Automático atendendo" em TODA conversa
    // sem dono, inclusive numa instalação que nunca configurou agente — afirmando
    // que o robô cuidava de conversas que ninguém estava respondendo, na primeira
    // impressão, que é P0.
    const r = comandoDaConversa(fatos({ automaticoDaOrg: false }), AGORA);
    expect(r.comando).toEqual({ quem: "ninguem" });
  });

  it("'não sei' NÃO vira 'não há': leitura ausente mantém o comportamento anterior", () => {
    // `undefined` é leitura em andamento ou que falhou. Traduzi-la para "não há
    // automático" seria a mesma mentira ao contrário — e ela apareceria em toda
    // instalação configurada, no primeiro segundo de cada carregamento.
    for (const f of [fatos(), fatos({ automaticoDaOrg: undefined })]) {
      expect(comandoDaConversa(f, AGORA).comando).toEqual({ quem: "automatico" });
    }
  });

  it("a org sem automático não muda quem manda quando há dono humano", () => {
    // O fato é sobre a ORG, não sobre a conversa: com dono, quem manda é a pessoa,
    // configurada ou não a automação.
    const r = comandoDaConversa(
      fatos({ assigned_to_user_id: ATENDENTE, assigned_to_user_name: "Maria", automaticoDaOrg: false }),
      AGORA,
    );
    expect(r.comando).toEqual({ quem: "humano", userId: ATENDENTE, nome: "Maria" });
  });

  it("conversa FECHADA continua nomeando quem atendeu", () => {
    // A aba "Fechadas" é onde "quem atendeu isto?" é a única pergunta que importa,
    // e a versão anterior colapsava para 'encerrada' e jogava o nome fora.
    const r = comandoDaConversa(
      fatos({ status: "closed", assigned_to_user_id: ATENDENTE, assigned_to_user_name: "Maria" }),
      AGORA,
    );
    expect(r.comando).toEqual({ quem: "humano", userId: ATENDENTE, nome: "Maria" });
    // E continua sendo verdade que ninguém está atendendo agora.
    expect(r.automaticoAtivo).toBe(false);
  });

  it("conversa fechada SEM dono é 'encerrada' — não há nome a preservar", () => {
    expect(comandoDaConversa(fatos({ status: "archived" }), AGORA).comando).toEqual({
      quem: "encerrada",
    });
  });
});

describe("travaVigente — o fato que decide o botão de volta", () => {
  it("conversa encerrada LIMPA não tem trava: o botão de devolver não deve aparecer", () => {
    // O defeito que este caso existe para impedir: derivar o botão de
    // `!automaticoAtivo` o faria aparecer em TODA conversa fechada, e clicá-lo
    // reabriria uma conversa que ninguém pediu para reabrir.
    const r = comandoDaConversa(
      fatos({ status: "closed", assigned_to_user_id: ATENDENTE }),
      AGORA,
    );
    expect(r.automaticoAtivo).toBe(false);
    expect(r.travaVigente).toBe(false);
  });

  it("conversa encerrada COM trava pendurada: o botão de devolver PRECISA aparecer", () => {
    // O beco sem saída medido: o atendente assume, fecha e some. "Liberar" só
    // existe para o próprio dono e a rota recusa quem não é — sem esta porta,
    // nenhum colega consegue devolver o atendimento.
    for (const f of [
      fatos({ status: "closed", assigned_to_user_id: ATENDENTE, bot_silenced_until: "infinity" }),
      fatos({ status: "archived", force_human: true }),
    ]) {
      expect(comandoDaConversa(f, AGORA).travaVigente).toBe(true);
    }
  });

  it("dono humano SEM trava (a conversa que o rodízio distribuiu) não tem o que devolver", () => {
    // O rodízio atribui sem calar, de propósito. Aqui o gesto certo é pausar, não
    // devolver — e oferecer "devolver" seria oferecer o desfazer de algo que não
    // foi feito.
    const r = comandoDaConversa(
      fatos({ status: "claimed", assigned_to_user_id: ATENDENTE }),
      AGORA,
    );
    expect(r.automaticoAtivo).toBe(true);
    expect(r.travaVigente).toBe(false);
  });
});

describe("o espelho entre a tela e o motor", () => {
  /**
   * Os gates que calam o automático vivem em DOIS arquivos de produção. Se um
   * deles ganhar um gate novo, esta função passa a explicar menos do que o motor
   * faz — e a tela vira uma afirmação falsa sobre o comportamento. Este caso não
   * verifica a lógica: verifica que ninguém acrescentou gate sem passar por aqui.
   */
  const RAIZ = join(__dirname, "..", "..");

  it("o gate do motor moderno segue lendo exatamente force_human + bot_silenced_until", () => {
    const fonte = readFileSync(
      join(RAIZ, "lib/agent-engine/agent/human-handoff.ts"),
      "utf8",
    );
    const corpo = fonte.slice(fonte.indexOf("export async function isLeadInHandoff"));
    const sql = corpo.slice(corpo.indexOf("`"), corpo.indexOf("[tenantId, leadId]"));
    const colunas = ["force_human", "bot_silenced_until"];
    for (const c of colunas) expect(sql).toContain(c);
    // O controle: nenhuma OUTRA coluna de conversa entrou no gate sem que este
    // arquivo aprendesse a explicá-la.
    for (const naoEsperada of ["assignee_kind", "assigned_to_user_id", "last_handoff_at"]) {
      expect(sql).not.toContain(naoEsperada);
    }
  });

  it("o worker legado segue com os três guards que esta função espelha", () => {
    const fonte = readFileSync(join(RAIZ, "workers/ai-response-worker.ts"), "utf8");
    expect(fonte).toContain('skip("force_human")');
    expect(fonte).toContain('skip("assigned_to_human")');
    expect(fonte).toContain('skip("silenced_post_handoff")');
  });

  it("todo estado e todo motivo têm rótulo, e a palavra do estado é 'automático'", () => {
    expect(Object.keys(ROTULO_DO_COMANDO).sort()).toEqual(
      ["aguardando", "automatico", "encerrada", "humano", "ninguem"],
    );
    // Seis desde 2026-09-24: `atendimento_pelo_celular` (C-075) entrou junto com
    // a pausa durável por resposta no celular. O número fica escrito porque motivo
    // novo tem de ganhar rótulo no mesmo commit — um motivo sem rótulo imprime a
    // chave crua.
    expect(Object.keys(ROTULO_DO_MOTIVO)).toHaveLength(6);
    // "IA" no rótulo colidiria com o léxico que o produto já fixou em quatro
    // arquivos e que `handoff-por-orcamento.test.ts` usa como sabotagem-controle.
    for (const rotulo of Object.values(ROTULO_DO_MOTIVO)) {
      expect(rotulo).not.toMatch(/\bIA\b/);
    }
  });
});

describe("o que entrou quando o banco passou a calcular o mesmo comando", () => {
  it("'-infinity' NÃO é silêncio — é um silêncio que já venceu", () => {
    // Sem o ramo explícito ele caía no fallback de "data ilegível = calado", e o
    // Postgres discorda: `'-infinity' > now()` é false. Quem grava é o banco.
    const r = comandoDaConversa(fatos({ bot_silenced_until: "-infinity" }), AGORA);
    expect(r.comando).toEqual({ quem: "automatico" });
    expect(r.automaticoAtivo).toBe(true);
  });

  it("mas data ilegível de verdade CONTINUA calando — falha fechada", () => {
    // O controle do caso acima: um conserto que tratasse toda string estranha
    // como "sem silêncio" passaria no teste anterior e abriria o automático em
    // cima de dado que ninguém sabe ler.
    expect(comandoDaConversa(fatos({ bot_silenced_until: "banana" }), AGORA).automaticoAtivo).toBe(
      false,
    );
    expect(comandoDaConversa(fatos({ bot_silenced_until: "infinity" }), AGORA).automaticoAtivo).toBe(
      false,
    );
  });

  it("'resolved' é conversa encerrada, e por isso não vai para a fila", () => {
    const r = comandoDaConversa(fatos({ status: "resolved" }), AGORA);
    expect(r.comando).toEqual({ quem: "encerrada" });
    expect(r.motivo).toBeNull();
  });

  it("contato descadastrado: o automático não atende, e a tela diz o motivo certo", () => {
    const r = comandoDaConversa(fatos({ is_blocked: true }), AGORA);
    expect(r.comando).toEqual({ quem: "aguardando" });
    expect(r.automaticoAtivo).toBe(false);
    expect(r.motivo).toBe("contato_descadastrado");
  });

  it("MAS o descadastro NÃO acende 'Devolver ao automático' — seria botão decorativo", () => {
    // `travaVigente` é o que desenha o botão. Devolver não desfaz opt-out: o
    // `stopGate` de before-send recusa na mesma. É o defeito do PR #295.
    expect(comandoDaConversa(fatos({ is_blocked: true }), AGORA).travaVigente).toBe(false);
    // E ele apaga a trava mesmo quando havia outra devolvível junto.
    const comAsDuas = comandoDaConversa(fatos({ is_blocked: true, force_human: true }), AGORA);
    expect(comAsDuas.travaVigente).toBe(false);
    expect(comAsDuas.motivo).toBe("contato_descadastrado");
  });

  it("o controle: force_human sozinho CONTINUA acendendo o botão", () => {
    // Sem este caso, um conserto que zerasse `travaVigente` sempre passaria nos
    // dois acima e esconderia a única porta de volta que existe.
    const r = comandoDaConversa(fatos({ force_human: true }), AGORA);
    expect(r.travaVigente).toBe(true);
    expect(r.motivo).toBe("contato_travado");
  });

  it("a fila pede 'aguardando' — e 'automatico' também quando a org não tem robô", () => {
    expect(comandosDaFila(true)).toEqual(["aguardando"]);
    expect(comandosDaFila(undefined)).toEqual(["aguardando"]);
    // Sem automático de pé, `automatico` não descreve ninguém: essas conversas
    // estão esperando gente, e deixá-las fora faria a Fila de uma instalação
    // nova nascer vazia com clientes sem resposta.
    expect(comandosDaFila(false)).toEqual(["aguardando", "automatico"]);
  });

  it("o vocabulário do banco tem QUATRO — 'ninguem' é renomeação de TS, não estado", () => {
    expect([...COMANDOS_DO_BANCO]).toEqual(["humano", "automatico", "aguardando", "encerrada"]);
    expect(COMANDOS_DO_BANCO as readonly string[]).not.toContain("ninguem");
  });
});
