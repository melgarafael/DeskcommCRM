import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A TIMELINE NÃO PROMETE O VALOR ANTERIOR NO `api_audit_log` (issue #1755).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 * O comentário que protege a timeline contra PII prometia um lugar que não
 * existe: "Quem precisa do valor anterior tem `api_audit_log`". Mas o audit
 * de `lead.updated` guarda só `{ fields }` — os NOMES dos campos, nunca o
 * antes-e-depois. O valor anterior não está em lugar nenhum.
 *
 * Consequência: quem lesse o comentário acreditava que o histórico de valores
 * existia (para responder "quem mudou o valor desta proposta, e de quanto para
 * quanto?"), e descobria que não na hora em que precisava; e a próxima pessoa
 * que pensasse em pôr o antes-e-depois na timeline era desviada para um lugar
 * vazio.
 *
 * O comentário agora diz o que o código faz: o ANTES-E-DEPOIS só dos campos
 * tipados sem PII vai para o `api_audit_log` (saída (b) da #1755), e o valor
 * de título, descrição, tags e `custom_fields` — PII ou dado arbitrário do
 * tenant — continua sem lugar nenhum. Se alguém voltar a prometer acesso
 * geral ao audit, este arquivo fica vermelho; se a lista branca crescer para
 * coluna de texto, o arquivo irmão
 * `lead-audit-antes-depois-so-dos-campos-tipados.test.ts` fica.
 *
 * ─── Por que ler o fonte em vez de testar a rota com handler dublado ──────
 * O que regride aqui é um TEXTO — a justificativa escrita ao lado do `reason`.
 * Um teste que dubla o handler mede o fluxo, não o comentário, e deixaria o
 * defeito reaparecer ("quem precisa tem api_audit_log") sem ninguém ver. O
 * alvo é a frase que engana, então é a frase que o teste prende — junto com a
 * forma do audit que ela descrevia, para o texto não mentir de novo.
 */

const RAIZ = process.cwd();
const HANDLER = path.join(RAIZ, "app/api/v1/leads/_handler.ts");

/** A frase que prometia o lugar inexistente — deve voltar a existir para o teste virar vermelho. */
const PROMESSA_ANTIGA = "Quem precisa do valor anterior tem `api_audit_log`";

/** A confissão que valeu enquanto NADA era guardado — hoje seria mentira. */
const CONFESSAO_VELHA = "O valor anterior NÃO é guardado em lugar nenhum";

/** A regra medida que a #1755 passou a vigiar: lista branca, não acesso geral. */
const REGRA_NOVA = "ANTES-E-DEPOIS SÓ DOS CAMPOS TIPADOS SEM PII";

describe("o comentário da timeline não promete o valor anterior", () => {
  it("diz a regra medida: antes-depois só dos campos tipados sem PII", () => {
    const fonte = fs.readFileSync(HANDLER, "utf8");
    expect(fonte).toContain(REGRA_NOVA);
    // CONTROLE DE VACUIDADE: a frase de quando NADA era guardado também não
    // pode voltar — hoje ela seria mentira no sentido oposto.
    expect(fonte).not.toContain(CONFESSAO_VELHA);
  });

  it("não reaparece a promessa de que 'quem precisa do valor anterior tem api_audit_log'", () => {
    const fonte = fs.readFileSync(HANDLER, "utf8");
    // CONTROLE DE VACUIDADE: sem este `expect`, apagar o comentário inteiro
    // passaria o teste com louvor — e o defeito (promessa de lugar vazio)
    // voltaria no texto, invisível.
    expect(fonte).not.toContain(PROMESSA_ANTIGA);
    // Guarda mais ampla: nenhuma linha de comentário liga "valor anterior" a
    // um lugar onde "tem" o valor. O comentário honesto também cita as duas
    // expressões, mas nega; só a frase que afirma o acesso regride.
    expect(fonte).not.toMatch(/valor anterior[^\n]{0,80}tem[^\n]{0,40}?api_audit_log/);
    expect(fonte).not.toMatch(/tem[^\n]{0,80}api_audit_log[^\n]*(registra a|guarda a)/);
  });

  it("o audit de lead.updated leva os nomes e o par antes/depois da lista branca", () => {
    const fonte = fs.readFileSync(HANDLER, "utf8");
    // Ache o bloco `audit({ ... action: "lead.updated" ... metadata: {...} })`.
    const inicio = fonte.indexOf('action: "lead.updated"');
    expect(inicio, "a rota não audita lead.updated (CONTROLE POSITIVO)").toBeGreaterThan(-1);
    // O bloco acaba no `return` do handler: uma janela fixa de chars corria
    // para dentro do comentário da função seguinte e acusava palavra alheia.
    const fim = fonte.indexOf("return (fresh ?? updated)", inicio);
    const blocoAudit = fonte.slice(inicio, fim > -1 ? fim : inicio + 700);

    // O audit leva `fields` (os nomes)… (controle positivo: sem ele, sumir o
    // audit passaria o teste.)
    expect(blocoAudit).toMatch(/metadata[^\n]*{?[^}]*fields/);
    // …e o par antes/depois, que só a lista branca de
    // lib/leads/valores-audit.ts preenche (issue #1755).
    expect(blocoAudit).toContain("valores");

    // Nenhuma chave de valor fora daquela lista.
    for (const chaveDeValor of ["before", "after", "anterior", "_antes", "old_value", "previous"]) {
      expect(blocoAudit, `o audit de lead.updated passou a guardar o valor (chave "${chaveDeValor}")`).not.toContain(
        chaveDeValor,
      );
    }
    // E nenhuma coluna de texto como chave do metadata: título (neste produto
    // É O NOME DO CLIENTE), descrição, tags e `custom_fields` não entram por
    // decreto — o audit é append-only e a cascata da LGPD não o reescreve.
    for (const colunaDeTexto of ["title:", "description:", "tags:", "custom_fields:"]) {
      expect(blocoAudit, `a coluna de texto "${colunaDeTexto}" virou chave do audit de lead.updated`).not.toContain(
        colunaDeTexto,
      );
    }
  });
});