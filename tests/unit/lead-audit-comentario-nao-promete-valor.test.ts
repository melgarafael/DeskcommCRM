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
 * O comentário agora diz o que o código faz hoje: o valor anterior NÃO é
 * guardado. Se o projeto passar a guardar o antes-e-depois de campos tipados
 * (saída (b) da #1755, ainda sem decisão), este arquivo fica vermelho de
 * propósito, e o comentário muda junto.
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

/** A verdade que substitui a promessa. */
const CONFISSAO_HONESTA = "valor anterior NÃO é guardado";

describe("o comentário da timeline não promete o valor anterior", () => {
  it("diz que o valor anterior NÃO é guardado", () => {
    const fonte = fs.readFileSync(HANDLER, "utf8");
    expect(fonte).toContain(CONFISSAO_HONESTA);
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

  it("o audit de lead.updated descreve só os NOMES dos campos, não um antes-e-depois", () => {
    const fonte = fs.readFileSync(HANDLER, "utf8");
    // Ache o bloco `audit({ ... action: "lead.updated" ...metadata: {...}})`.
    const inicio = fonte.indexOf('action: "lead.updated"');
    expect(inicio, "a rota não audita lead.updated (CONTROLE POSITIVO)").toBeGreaterThan(-1);
    const blocoAudit = fonte.slice(inicio, inicio + 400);

    // O audit leva `fields` (os nomes)… (controle positivo: sem ele, sumir o
    // audit passaria o teste.)
    expect(blocoAudit).toMatch(/metadata[^\n]*{?[^}]*fields/);
    // …e nenhuma chave de antes-e-depois. Se alguém passar a gravar o valor,
    // este expect fica vermelho e o comentário honesto deixa de ser verdade.
    for (const chaveDeValor of ["before", "after", "anterior", "_antes", "old_value", "previous"]) {
      expect(blocoAudit, `o audit de lead.updated passou a guardar o valor (chave "${chaveDeValor}")`).not.toContain(
        chaveDeValor,
      );
    }
  });
});