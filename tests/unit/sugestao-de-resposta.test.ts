import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  motivoDaFalha,
  sugestaoParaMostrar,
} from "@/lib/agent-engine/agent/sugestao-de-resposta";

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
