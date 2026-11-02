/**
 * OUVIDORIA — A TRANSIÇÃO DE STATUS (#3611, fatia 3).
 *
 * ─── Por que a régua mora aqui, e não na action ────────────────────────────
 *
 * Porque a pergunta "pode?" é uma conta sobre dois estados, e ela é a mesma na
 * tela (quais botões aparecem) e no servidor (o que é aceito). Escrita dentro da
 * action, a tela teria de repetir a conta para saber o que oferecer — e a cópia
 * da tela é a que ninguém corrige quando a do servidor muda. Aqui é função pura:
 * entra o status de hoje, o pedido e o motivo; sai "pode, com este motivo" ou
 * "não pode, por isto".
 *
 * ─── As três regras ────────────────────────────────────────────────────────
 *
 * 1. **Para frente, um degrau por vez.** `recebida → em_analise → concluida`.
 *    Pular (`recebida → concluida`) é recusado: uma manifestação marcada
 *    "concluída" sem nunca ter passado por análise não diz a quem reclamou que
 *    alguém a leu, e a trilha de auditoria ficaria com um buraco no meio.
 * 2. **Para trás, com motivo.** Reabrir (`concluida → em_analise` ou
 *    `concluida → recebida`) é legítimo — chegou informação nova, a resposta não
 *    resolveu —, mas exige um motivo escrito. O controle da issue é exatamente
 *    este: `concluida` não volta para `recebida` sem motivo. O motivo vai para a
 *    trilha (`api_audit_log.metadata`); não é coluna da tabela, e não é desta
 *    fatia criar uma (sem migration).
 * 3. **Nada para o mesmo lugar.** `X → X` não é transição: é um clique repetido.
 *    Aceitar gravaria uma linha de auditoria dizendo que algo mudou quando nada
 *    mudou — trilha que mente é pior que trilha curta.
 *
 * ─── Por que o motivo é medido em CARACTERES, com piso ─────────────────────
 *
 * `"ok"` não é motivo, e `" "` não é nada. O piso de `MOTIVO_MINIMO` existe para
 * o campo não virar um "salvar" com uma tecla. O teto existe pelo mesmo motivo
 * do teto do relato: acima disso o caso é anexo, que não é desta fatia.
 */
import { STATUS_DA_OUVIDORIA, type StatusDaOuvidoria } from "./registro";

/**
 * A ordem das etapas. O número NÃO é exibido em lugar nenhum — ele existe para a
 * régua ser uma comparação só, e não uma tabela de pares que envelhece quando
 * uma etapa nova entrar no CHECK.
 */
export const ORDEM_DO_STATUS: Record<StatusDaOuvidoria, number> = {
  recebida: 0,
  em_analise: 1,
  concluida: 2,
};

/** O piso do motivo de reabertura, em caracteres (depois do `trim`). */
export const MOTIVO_MINIMO = 10;

/** O teto do motivo, o mesmo tamanho de um comentário curto de operação. */
export const MOTIVO_MAXIMO = 500;

export type RecusaDaTransicao =
  | "status_invalido"
  | "mesmo_status"
  | "salto_de_etapa"
  | "motivo_obrigatorio"
  | "motivo_longo_demais";

export type ConferenciaDaTransicao =
  | {
      ok: true;
      de: StatusDaOuvidoria;
      para: StatusDaOuvidoria;
      /** O motivo já normalizado (`trim`), ou `null` quando não é reabertura. */
      motivo: string | null;
      /** `true` quando o movimento é para trás — a trilha registra o porquê. */
      reabertura: boolean;
    }
  | { ok: false; erro: RecusaDaTransicao };

/** O status pedido é um dos três do CHECK? */
export function ehStatusDaOuvidoria(v: unknown): v is StatusDaOuvidoria {
  return typeof v === "string" && (STATUS_DA_OUVIDORIA as readonly string[]).includes(v);
}

/**
 * As transições que a TELA oferece a partir de `de` — e só elas.
 *
 * A tela não repete a régua: ela pergunta aqui. `reabertura: true` diz ao
 * formulário que aquele destino exige motivo, e é o mesmo sinal que
 * `conferirTransicao` usa para recusar. Se a régua mudar, os botões mudam junto,
 * porque são a mesma função.
 *
 * ⚠️ A ordem é a de leitura: primeiro o degrau para frente, depois as
 * reaberturas, do mais próximo ao mais distante.
 */
export function proximosStatus(
  de: StatusDaOuvidoria,
): Array<{ para: StatusDaOuvidoria; reabertura: boolean }> {
  const degrau = ORDEM_DO_STATUS[de];
  const adiante = (STATUS_DA_OUVIDORIA as readonly StatusDaOuvidoria[])
    .filter((s) => ORDEM_DO_STATUS[s] === degrau + 1)
    .map((para) => ({ para, reabertura: false }));
  const atras = (STATUS_DA_OUVIDORIA as readonly StatusDaOuvidoria[])
    .filter((s) => ORDEM_DO_STATUS[s] < degrau)
    .sort((a, b) => ORDEM_DO_STATUS[b] - ORDEM_DO_STATUS[a])
    .map((para) => ({ para, reabertura: true }));
  return [...adiante, ...atras];
}

/**
 * Confere a transição. `pedido` e `motivo` chegam crus (é o que o servidor
 * recebe de uma Server Action), e a validação que vale é esta.
 */
export function conferirTransicao(
  de: StatusDaOuvidoria,
  pedido: unknown,
  motivoBruto: unknown,
): ConferenciaDaTransicao {
  if (!ehStatusDaOuvidoria(pedido)) return { ok: false, erro: "status_invalido" };
  if (pedido === de) return { ok: false, erro: "mesmo_status" };

  const motivo = typeof motivoBruto === "string" ? motivoBruto.trim() : "";

  // Para trás: reabertura, e o motivo é o controle da issue.
  if (ORDEM_DO_STATUS[pedido] < ORDEM_DO_STATUS[de]) {
    if (motivo.length < MOTIVO_MINIMO) return { ok: false, erro: "motivo_obrigatorio" };
    if (motivo.length > MOTIVO_MAXIMO) return { ok: false, erro: "motivo_longo_demais" };
    return { ok: true, de, para: pedido, motivo, reabertura: true };
  }

  // Para frente: só o degrau seguinte (ver regra 1 no cabeçalho).
  if (ORDEM_DO_STATUS[pedido] > ORDEM_DO_STATUS[de] + 1) {
    return { ok: false, erro: "salto_de_etapa" };
  }

  // Avançar não pede motivo: o motivo de reabertura é sobre DESFAZER um
  // encerramento. O que a pessoa escreveu aqui é ignorado de propósito, e o
  // registro do avanço fica na trilha com `de`/`para`.
  return { ok: true, de, para: pedido, motivo: null, reabertura: false };
}
