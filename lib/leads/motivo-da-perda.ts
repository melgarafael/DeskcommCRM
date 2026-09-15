import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * O MOTIVO DA PERDA — o ponto de decisão único de quem escreve ETAPA (issue #917).
 *
 * ─── A regra é do banco, e está certa ────────────────────────────────────────
 * `trg_crm_lead_close_on_stage` fecha o negócio quando a etapa de destino é de
 * perda (escreve `status = 'lost'`), e a CHECK `crm_leads_lost_reason_required`
 * recusa um negócio perdido sem motivo. Quem estava errado eram os três caminhos
 * que trocavam só o `stage_id`: arrasto, movimento em lote e movimento feito pela
 * IA. Escritos assim, o Postgres recusava a linha DEPOIS de o usuário já ter
 * decidido — e a recusa chegava como 500 (`internal_error`), que não diz a quem
 * opera o que fazer para completar a ação que ele pediu.
 *
 * ─── A pergunta é UMA ───────────────────────────────────────────────────────
 * "Esta escrita deixa o negócio PERDIDO sem motivo?" Ela mora aqui, e não em cada
 * rota, porque duas respostas para a mesma pergunta divergem no primeiro ajuste —
 * foi exatamente assim que os três caminhos passaram a responder diferente (um
 * recusava, outro estourava, o terceiro estourava calado num worker).
 *
 * ⚠️ O motivo sai na MESMA escrita que muda a etapa. Uma segunda escrita (antes ou
 * depois) tem janela: entre as duas o negócio está `lost` sem motivo — o estado
 * que a CHECK existe para impedir — e um erro entre as duas deixa o motivo
 * gravado na linha de um negócio que NÃO foi perdido.
 *
 * ⚠️ O motivo que o negócio JÁ tem vale. Trocar um card perdido de "Perdido" para
 * "Desistiu" não é uma perda nova: a CHECK é satisfeita pelo motivo que já está na
 * linha, e exigir um segundo motivo transformaria uma operação legítima que hoje
 * funciona numa recusa nova. Quem manda um motivo novo continua podendo corrigir.
 *
 * ⚠️ O QUE NÃO ESTÁ AQUI: o ganho (`is_won`). Nenhuma CHECK e nenhum trigger
 * exigem campo nenhum para fechar como ganho — inventar uma exigência só para o
 * desenho ficar simétrico quebraria escritas que hoje passam.
 */

/** O texto base da recusa — o dicionário (`traduzir`) traduz a partir daqui. */
export const MOTIVO_DA_PERDA_OBRIGATORIO = "Informe o motivo da perda.";

/**
 * A etapa de destino, com o mínimo que a decisão precisa saber dela. Aceita `null`
 * e campos ausentes de propósito: o chamador que não achou a etapa recebe a mesma
 * resposta que o chamador que achou uma etapa que não é de perda (nada a exigir),
 * e quem decide se "etapa inexistente" é 404 continua sendo a rota.
 */
export interface EtapaDeDestino {
  id?: string;
  name?: string | null;
  is_lost?: boolean | null;
}

/** O que entra na escrita quando a decisão autoriza. Vazio = nada a gravar. */
export type PatchDoMotivoDaPerda = { lost_reason?: string };

export type VereditoDoMotivoDaPerda =
  | { ok: true; patch: PatchDoMotivoDaPerda }
  | {
      ok: false;
      /** Mesmo código que a rota `/lose` já usa para esta recusa — uma só gramática. */
      codigo: "lost_reason_required";
      mensagem: string;
    };

/** Esta etapa fecha o negócio como PERDA? (Coluna do banco, nunca o nome da etapa.) */
export function etapaDePerda(etapa: EtapaDeDestino | null | undefined): boolean {
  return etapa?.is_lost === true;
}

/**
 * A decisão única: exige o motivo quando a escrita fecharia o negócio como perda
 * sem motivo, e devolve o `patch` que grava o motivo junto com a etapa.
 *
 * `motivoAtual` é o `lost_reason` que o negócio JÁ tem (a rota lê a linha antes de
 * escrever; `null`/vazio = nunca teve motivo). `idioma` só muda o texto da recusa.
 */
export function decideMotivoDaPerda(input: {
  etapaDeDestino: EtapaDeDestino | null | undefined;
  /** O motivo que ESTA operação mandou — o que o usuário digitou agora. */
  motivo?: string | null;
  /** O motivo que o negócio já tem gravado (troca entre etapas de perda). */
  motivoAtual?: string | null;
  idioma?: Idioma | null;
}): VereditoDoMotivoDaPerda {
  if (!etapaDePerda(input.etapaDeDestino)) return { ok: true, patch: {} };

  const motivo = (input.motivo ?? "").trim();
  if (motivo.length > 0) return { ok: true, patch: { lost_reason: motivo } };

  const atual = (input.motivoAtual ?? "").trim();
  if (atual.length > 0) return { ok: true, patch: {} };

  return {
    ok: false,
    codigo: "lost_reason_required",
    mensagem: traduzir(MOTIVO_DA_PERDA_OBRIGATORIO, input.idioma ?? IDIOMA_PADRAO),
  };
}

/** O texto da recusa, no idioma pedido — para quem precisa montá-la sem decidir. */
export function recusaDeMotivoDaPerda(idioma?: Idioma | null): {
  codigo: "lost_reason_required";
  mensagem: string;
} {
  return {
    codigo: "lost_reason_required",
    mensagem: traduzir(MOTIVO_DA_PERDA_OBRIGATORIO, idioma ?? IDIOMA_PADRAO),
  };
}

/**
 * A recusa do BANCO traduzida em recusa de negócio — ou `null` quando o erro não é
 * desta classe.
 *
 * ⚠️ REDE DE SEGURANÇA, e não o caminho esperado: com a decisão acima, nenhum dos
 * três caminhos chega aqui. Ela existe para o caminho NOVO — o worker que alguém
 * escrever amanhã trocando `stage_id` direto —, porque o defeito da #917 é
 * exatamente este: a regra do banco chegar ao operador como 500. Cobre as três
 * recusas que a CHECK e o trigger `fn_validate_lost_reason_required` produzem:
 *
 *  - `23514` em `crm_leads_lost_reason_required` — perda sem motivo (a CHECK);
 *  - `22023` `lost_reason_required` — o mesmo caso pelo trigger, em UPDATE que
 *    escreve `status`/`lost_reason` na lista de colunas;
 *  - `22023` `lost_reason_invalid` — o motivo não está no vocabulário do funil (o
 *    conjunto canônico mais `crm_pipelines.settings.lost_reasons` do tenant).
 *
 * A comparação é pelo NOME da constraint e pelos marcadores (`lost_reason_*`) que
 * o SQL do repo levanta — nunca por texto solto, que muda de idioma e de versão.
 */
export function recusaDeMotivoDaPerdaPeloBanco(
  erro: { code?: string | null; message?: string | null } | null | undefined,
  idioma?: Idioma | null,
): { codigo: "lost_reason_required" | "lost_reason_invalid"; mensagem: string } | null {
  const codigo = erro?.code ?? "";
  const texto = erro?.message ?? "";

  if (codigo === "23514" && texto.includes("crm_leads_lost_reason_required")) {
    return recusaDeMotivoDaPerda(idioma);
  }
  if (codigo === "22023" && texto.includes("lost_reason_required")) {
    return recusaDeMotivoDaPerda(idioma);
  }
  if (codigo === "22023" && texto.includes("lost_reason_invalid")) {
    return {
      codigo: "lost_reason_invalid",
      mensagem: traduzir(
        "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.",
        idioma ?? IDIOMA_PADRAO,
      ),
    };
  }
  return null;
}
