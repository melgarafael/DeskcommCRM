import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODIGOS_DE_VETO_CONHECIDOS,
  motivoDaFalha,
  motivoDoVeto,
  sugestaoParaMostrar,
} from "@/lib/agent-engine/agent/sugestao-de-resposta";
import { DICIONARIO } from "@/lib/i18n/dicionario";

/**
 * Os dois defeitos medidos em produção em 2026-09-12, na tela de atendimento.
 *
 * **1. A sugestão rejeitada não saía da tela.** O painel mostrava a mais recente
 * sem olhar o estado. Rejeitar não fecha nada, e não há botão de fechar no
 * componente — então o texto morto ficava ali. Quando a geração seguinte também
 * falhava, a tela travava naquele estado, sem saída.
 *
 * **2. O erro não dizia nada, e o identificador não levava a lugar nenhum.** A
 * rota fazia `} catch {`, sem nome: a causa era descartada, três situações
 * diferentes viravam a mesma frase, e nada era registrado — mas a tela exibia o
 * identificador da requisição, o que faz a mensagem parecer rastreável.
 *
 * Os dois casos cobrem o CAMINHO DO ERRO, que é o que paga: a sugestão que some
 * e a causa que aparece. Cada regra tem também o seu controle no sentido oposto,
 * porque uma função que devolvesse SEMPRE `undefined` (ou sempre o genérico)
 * passaria por metade destes casos sem conservar nada.
 */

type Sugestao = { id: string; status: string };
const s = (status: string, id = "d1"): Sugestao => ({ id, status });

describe("qual sugestão o painel mostra", () => {
  it("⛔ a REJEITADA sai da tela — é o defeito que travou a tela do dono", () => {
    expect(sugestaoParaMostrar([s("dismissed")])).toBeUndefined();
  });

  it("⛔ a OBSOLETA e a JÁ ENVIADA também saem", () => {
    // A enviada já aparece na conversa logo acima; repeti-la numa caixa
    // desabilitada diz duas vezes a mesma coisa.
    expect(sugestaoParaMostrar([s("stale")])).toBeUndefined();
    expect(sugestaoParaMostrar([s("sent")])).toBeUndefined();
  });

  it("CONTROLE: a que espera revisão CONTINUA aparecendo", () => {
    // Sem este caso, uma implementação que escondesse tudo passaria nos de cima
    // e apagaria o recurso inteiro — o erro em espelho, e o mais fácil de fazer.
    expect(sugestaoParaMostrar([s("pending")])?.status).toBe("pending");
  });

  it("CONTROLE: as intermediárias continuam aparecendo", () => {
    for (const vivo of ["generating", "approved", "sending"])
      expect(sugestaoParaMostrar([s(vivo)])?.status, vivo).toBe(vivo);
  });

  it("a que FALHOU continua aparecendo — ela é a única pista que sobra", () => {
    // Deliberado: o texto dela diz o que conferir. Esconder deixaria quem
    // atende sem nenhuma explicação para a sugestão que não veio.
    expect(sugestaoParaMostrar([s("failed")])?.status).toBe("failed");
  });

  it("⛔ NÃO ressuscita uma sugestão antiga quando a atual é rejeitada", () => {
    // A correção ingênua — procurar na lista a primeira que ainda sirva — faria
    // um texto que o atendente acabou de rejeitar voltar sozinho para a tela,
    // vindo de uma sugestão anterior. Olha só a mais recente, de propósito.
    expect(sugestaoParaMostrar([s("dismissed", "novo"), s("pending", "velho")])).toBeUndefined();
  });

  it("sem sugestão nenhuma, painel neutro", () => {
    expect(sugestaoParaMostrar([])).toBeUndefined();
    expect(sugestaoParaMostrar(undefined)).toBeUndefined();
  });
});

describe("o que a tela diz quando a geração falha", () => {
  it("⛔ 'não há agente publicado' deixa de virar a frase genérica", () => {
    const m = motivoDaFalha(new Error("reply_no_agent"));
    expect(m.codigo).toBe("reply_no_agent");
    expect(m.acionavel).toBe(true);
    expect(m.texto).toMatch(/publicad/i);
  });

  it("⛔ 'contexto indisponível' diz as três causas reais", () => {
    const m = motivoDaFalha(new Error("reply_context_unavailable"));
    expect(m.codigo).toBe("reply_context_unavailable");
    expect(m.acionavel).toBe(true);
  });

  it("causa desconhecida NÃO finge saber, e promete o registro", () => {
    // A frase antiga mandava "conferir a publicação e a configuração do agente"
    // mesmo quando o problema era o provedor de IA fora do ar. Mandar a pessoa
    // mexer na configuração certa é pior que admitir que não se sabe.
    const m = motivoDaFalha(new Error("timeout do provedor"));
    expect(m.codigo).toBe("reply_unavailable");
    expect(m.acionavel).toBe(false);
    expect(m.texto).not.toMatch(/Confira a publicação/i);
  });

  it("não quebra com o que não é Error", () => {
    for (const estranho of [undefined, null, "texto solto", 42])
      expect(motivoDaFalha(estranho).codigo).toBe("reply_unavailable");
  });

  it("CONTROLE: as três frases são distintas — senão o conserto é só aparência", () => {
    const textos = [
      motivoDaFalha(new Error("reply_no_agent")).texto,
      motivoDaFalha(new Error("reply_context_unavailable")).texto,
      motivoDaFalha(new Error("outro")).texto,
    ];
    expect(new Set(textos).size).toBe(3);
  });
});

describe("a rota não volta a engolir a causa", () => {
  const ROTA = path.join(
    process.cwd(),
    "app",
    "api",
    "v1",
    "conversations",
    "[id]",
    "draft-reply",
    "route.ts",
  );
  const fonte = fs.readFileSync(ROTA, "utf8");

  it("⛔ nenhum `catch` sem nome — foi ele que descartou a causa", () => {
    // A cerca é por forma porque o defeito é de forma: `} catch {` compila,
    // passa no lint, passa no typecheck e passa na suíte. Só um leitor humano
    // percebia — e por meses ninguém percebeu.
    expect(/catch\s*\{/.test(fonte), "há um `catch {` sem nome nesta rota").toBe(false);
  });

  it("⛔ a causa é REGISTRADA — senão o identificador na tela não leva a nada", () => {
    expect(fonte).toMatch(/logger\.error\(/);
  });

  it("CONTROLE: a cerca acima reprovaria mesmo — ela casa com a forma proibida", () => {
    // Guarda de vacuidade: se a expressão parasse de casar com qualquer coisa,
    // o caso de cima ficaria verde para sempre, inclusive com o defeito de volta.
    expect(/catch\s*\{/.test("try { x() } catch { }")).toBe(true);
  });
});

/**
 * A TERCEIRA REGRA (issue #2975): o CÓDIGO do veto vira a frase de quem opera.
 *
 * O rascunho guarda só o código do primeiro impedimento
 * (`ai_reply_drafts.error_code`), e o painel mostrava a MESMA frase genérica
 * para todos os vetos — de "o contato está descadastrado" a "a janela de 24h
 * fechou". Esta suíte varre o CATÁLOGO inteiro (exportado pelo módulo, para que
 * um `case` novo sem par aqui deixe de ser silencioso) e cobra o lado oposto:
 * código desconhecido ou ausente devolve `null`, que é o que mantém o texto
 * genérico na tela.
 */
describe("o código do veto vira a causa em linguagem de quem opera", () => {
  it("todo código conhecido tem causa própria, com ação avaliada", () => {
    for (const codigo of CODIGOS_DE_VETO_CONHECIDOS) {
      const motivo = motivoDoVeto(codigo);
      expect(motivo, `sem tradução para ${codigo}`).not.toBeNull();
      expect(motivo!.codigo).toBe(codigo);
      expect(motivo!.texto.length, `texto curto demais em ${codigo}`).toBeGreaterThan(30);
      expect(typeof motivo!.acionavel).toBe("boolean");
    }
  });

  /**
   * `causa` vai no aviso de versão barrada (doc 234), sobre uma sugestão que
   * está sendo OFERECIDA: frase curta, sem instrução e sem ponto (a moldura põe
   * o seu). Quem não barra versão nenhuma não tem causa — um veto novo sem ela
   * sumiria do aviso em silêncio, por isso a lista dos sem-causa é fechada.
   */
  it("só os vetos de envio têm causa, e a causa não manda agir", () => {
    const semCausa = CODIGOS_DE_VETO_CONHECIDOS.filter((c) => !motivoDoVeto(c)!.causa);
    expect(semCausa.sort()).toEqual(
      ["generation_failed", "max_steps_exhausted", "no_candidate", "output_truncated", "unknown_preview_tool"],
    );
    for (const codigo of CODIGOS_DE_VETO_CONHECIDOS) {
      const causa = motivoDoVeto(codigo)!.causa;
      if (!causa) continue;
      expect(causa, codigo).not.toMatch(/gere de novo|nada foi enviado|confira|ajuste|\.$/i);
      // A tela passa a causa por `t(motivo.causa)`, forma que a guarda do
      // espanhol não resolve: a cobertura no dicionário é cobrada aqui.
      expect(DICIONARIO[causa]?.es, `sem espanhol para a causa de ${codigo}`).toBeTruthy();
    }
  });

  /**
   * A CONFERÊNCIA DE AFIRMAÇÃO DE FATO (#2231) tem duas causas que se parecem
   * e não são a mesma: o material CONTRADIZ o que a resposta dizia, ou o
   * material simplesmente não apoia. Quem atende age igual nos dois casos, mas
   * a frase não pode ser a mesma — e, até aqui, nenhum teste comparava as duas.
   * Medido: invertendo os dois corpos em `motivoDoVeto`, os 24 casos da base
   * seguiam verdes.
   */
  it("⛔ a afirmação CONTRADITA e a SEM APOIO não podem trocar de frase", () => {
    const contradita = motivoDoVeto("factual_claim_contradicted")!;
    const semApoio = motivoDoVeto("factual_claim_unsupported")!;

    expect(contradita.texto).not.toBe(semApoio.texto);
    expect(contradita.texto).toMatch(/CONTRADIZ/);
    expect(contradita.texto).not.toMatch(/sem apoio/);
    expect(semApoio.texto).toMatch(/sem apoio/);
    expect(semApoio.texto).not.toMatch(/CONTRADIZ/);
  });

  it("as causas DEFINITIVAS (opt-out, LGPD) não fingem ter ação local", () => {
    expect(motivoDoVeto("contato_bloqueado")!.acionavel).toBe(false);
    expect(motivoDoVeto("lgpd_anonymized")!.acionavel).toBe(false);
  });

  it("generation_failed abre pela falha de geração e não culpa provedor nem chave", () => {
    // Quem grava `generation_failed` é o catch de `reply-drafts.ts`: a prévia ou o
    // LLM lançou, ou `getLeadContext` não montou o contexto. Contato bloqueado ou
    // anonimizado é recusado ANTES, por `fn_reply_begin` (rota 422
    // `reply_context_unavailable`, sem rascunho gravado) — por isso a frase não o
    // nomeia como causa. E não manda conferir a chave: o motivo real fica no log.
    const texto = motivoDoVeto("generation_failed")!.texto;
    expect(texto).not.toMatch(/provedor|chave|tempo esgotado/i);
    expect(texto).toMatch(/^A geração da sugestão falhou/);
    expect(texto).toMatch(/contexto da conversa/);
  });

  it("⛔ 'o agente terminou sem propor resposta' (no_candidate) não vira erro de configuração", () => {
    // Caso real: a abordagem recebeu a saudação automática do WhatsApp Business,
    // e o agente, certo, não respondeu. O painel dizia "Confira a configuração do
    // agente" — fazendo uma decisão correta parecer defeito. Mas no_candidate
    // também nasce de parada (texto solto, truncamento, passos esgotados), então
    // o texto não pode afirmar a decisão: oferece gerar de novo.
    const motivo = motivoDoVeto("no_candidate")!;
    expect(motivo.acionavel).toBe(true);
    expect(motivo.texto).toMatch(/sem propor uma resposta/);
    expect(motivo.texto).toMatch(/gere de novo/);
    expect(motivo.texto).not.toMatch(/configura|falhou|erro/i);
    // O código é contrato do motor: é o impedimento que a prévia grava quando o
    // agente não propôs resposta. Ele deixou de nascer no closure do turno
    // (#3093): a decisão do desfecho saiu para o módulo puro
    // `desfecho-da-previa.ts`, e é lá que o nome passa a valer. O motor continua
    // sendo quem pergunta — sem a chamada, o código não chega à prévia.
    const motor = fs.readFileSync(
      path.join(__dirname, "../../lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const desfecho = fs.readFileSync(
      path.join(__dirname, "../../lib/agent-engine/agent/desfecho-da-previa.ts"),
      "utf8",
    );
    expect(motor).toMatch(/desfechoSemCandidato\(\{/);
    expect(desfecho).toMatch(/code: 'no_candidate'/);
    // #3093: truncamento e teto de passos NÃO podem voltar a cair aqui — é o
    // defeito que esta suíte existe para não deixar renascer.
    expect(desfecho).toMatch(/code: 'output_truncated'/);
    expect(desfecho).toMatch(/code: 'max_steps_exhausted'/);
  });

  it("CONTROLE: código desconhecido e ausente devolvem null — o genérico fica", () => {
    expect(motivoDoVeto("veto_que_ainda_nao_existe")).toBeNull();
    expect(motivoDoVeto(null)).toBeNull();
    expect(motivoDoVeto(undefined)).toBeNull();
  });
});
