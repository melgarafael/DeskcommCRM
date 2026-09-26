import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";

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
 * ⚠️ O motivo que o negócio JÁ tem vale — para quem ARRASTA. Reordenar um card
 * dentro da coluna de perda não é uma perda nova: a CHECK é satisfeita pelo motivo
 * que já está na linha, e exigir um segundo motivo transformaria uma operação
 * legítima que hoje funciona numa recusa nova. Quem manda um motivo novo continua
 * podendo corrigir. (Trocar "Perdido" por "Desistiu" NÃO é caso real, embora este
 * parágrafo já o tenha dito: `uniq_crm_stages_pipeline_lost` admite UMA etapa de
 * perda não arquivada por funil.)
 *
 * ⚠️ O AGENTE não usa essa licença: `resolveDestinoDoAgente`
 * (lib/leads/agent-stage-sync.ts) chama esta decisão SEM `motivoAtual`. O único
 * negócio com motivo gravado que ele alcança é o reaberto, e ali o motivo é o da
 * perda anterior — o porquê completo está no tipo `perda_sem_motivo` de lá.
 *
 * ⚠️ O QUE NÃO ESTÁ AQUI: o ganho (`is_won`). Nenhuma CHECK e nenhum trigger
 * exigem campo nenhum para fechar como ganho — inventar uma exigência só para o
 * desenho ficar simétrico quebraria escritas que hoje passam.
 */

/**
 * ⚠️ A ÚNICA ESCRITA QUE FECHA COMO PERDA SEM PERGUNTAR O MOTIVO: a troca de
 * funil (`POST /api/v1/leads/[id]/clone`). Ela mora AQUI, e não no módulo do
 * clone, porque duas decisões sobre o motivo da perda em dois arquivos é
 * exatamente o defeito que a #917 veio eliminar — e a divergência entraria
 * calada, já que os dois lados nunca tocam a mesma linha.
 *
 * Por que a exceção é legítima: no clone o negócio NÃO se perdeu. Ele foi
 * levado para outro funil, e a origem é encerrada como perda porque é o único
 * desfecho que o schema oferece para "saiu daqui". Perguntar um motivo ao
 * operador o obrigaria a inventar uma causa comercial para um movimento
 * administrativo. O motivo é PRÓPRIO e canônico — `moved_to_another_pipeline`, e
 * não `other` —, porque as duas coisas se separam na hora de olhar a métrica:
 * quem perdeu para o concorrente e quem foi levado para outro funil não são a
 * mesma perda, e `fn_attendant_metrics` EXCLUI este motivo da contagem de perdas
 * (migration 0266), de modo que a transferência não engorda o número de perdas
 * de ninguém. Para onde o negócio foi fica em `source_metadata.movido_para`, que
 * é onde a informação sobrevive. A instrução original da P-01 —
 * `lost_reason='moved_to_pipeline_X'` — seria recusada com 22023
 * `lost_reason_invalid` e perderia a troca inteira, não só a informação.
 *
 * ⚠️ Exigir motivo também na troca de funil é decisão do dono do produto, não
 * um ajuste de consistência: hoje a troca funciona sem perguntar.
 */
export const MOTIVO_DA_TRANSFERENCIA = "moved_to_another_pipeline";

/** O motivo com que a troca de funil encerra a ORIGEM. */
export const MOTIVO_PADRAO_DA_TROCA = MOTIVO_DA_TRANSFERENCIA;

/** O motivo com que a troca de funil encerra a ORIGEM. */
export function motivoDaPerdaDaOrigem(informado?: string | null): string {
  const limpo = informado?.trim();
  return limpo && limpo.length > 0 ? limpo : MOTIVO_PADRAO_DA_TROCA;
}

/** O texto base da recusa — o dicionário (`traduzir`) traduz a partir daqui. */
/**
 * A recusa diz a SAÍDA, não só a falta: quem arrastou o card para a etapa de perda
 * não tem onde digitar o motivo no arrasto, e a janela que pede o motivo mora no
 * menu do card. O nome citado aqui é o rótulo do item de menu — um teste prende os
 * dois, para renomear o menu quebrar o teste em vez de deixar a recusa apontando
 * para um lugar que não existe.
 */
export const MOTIVO_DA_PERDA_OBRIGATORIO =
  "Informe o motivo da perda: use “Marcar como perdido” no menu do card, que pede o motivo.";

/** O texto base da recusa por vocabulário — o mesmo que a rede de segurança usa. */
export const MOTIVO_DA_PERDA_FORA_DO_VOCABULARIO =
  "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.";

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
  /** O motivo que o negócio já tem gravado (card que já está na etapa de perda). */
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
      mensagem: traduzir(MOTIVO_DA_PERDA_FORA_DO_VOCABULARIO, idioma ?? IDIOMA_PADRAO),
    };
  }
  return null;
}

/**
 * O motivo está no vocabulário do funil? — a MESMA pergunta que
 * `fn_validate_lost_reason_required` faz (supabase/baseline.sql), antes de a
 * escrita acontecer.
 *
 * ⚠️ POR QUE PERGUNTAR ANTES, se o banco já recusa: porque há um caminho em que a
 * recusa do banco chega TARDE DEMAIS. A troca de funil
 * (`POST /api/v1/leads/[id]/clone`) são duas escritas sem transação entre elas —
 * cria o clone, depois encerra a origem. Um `lost_reason` fora do vocabulário só
 * era recusado na SEGUNDA, e o operador recebia 500 com o negócio já duplicado no
 * destino e a origem ainda aberta. Barrar aqui custa uma leitura e não deixa
 * meia-execução nenhuma.
 *
 * `settingsDoFunil` é o `crm_pipelines.settings` cru: a lista do tenant vive em
 * `settings.lost_reasons`, e `settings` sem ela significa "só os canônicos" — que
 * é o que o `coalesce(..., '{}')` do trigger faz.
 *
 * Devolve `null` quando não há o que recusar (sem motivo informado, ou motivo
 * aceito): quem decide se motivo AUSENTE é recusa é `decideMotivoDaPerda`.
 */
export function recusaDeMotivoForaDoVocabulario(input: {
  motivo?: string | null;
  settingsDoFunil: unknown;
  idioma?: Idioma | null;
}): { codigo: "lost_reason_invalid"; mensagem: string } | null {
  const motivo = (input.motivo ?? "").trim();
  if (motivo.length === 0) return null;

  const extras = (input.settingsDoFunil as { lost_reasons?: unknown } | null | undefined)
    ?.lost_reasons;
  const aceitos = new Set<string>([
    ...CANONICAL_LOST_REASONS,
    // #1537: o item é texto puro OU `{ label, categoria }` — o mesmo que o trigger
    // aceita; ler só o texto recusava aqui o motivo que o banco aceitaria.
    ...(Array.isArray(extras)
      ? extras
          .map((v) => (typeof v === "string" ? v : (v as { label?: unknown } | null)?.label))
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      : []),
  ]);
  if (aceitos.has(motivo)) return null;

  return {
    codigo: "lost_reason_invalid",
    mensagem: traduzir(MOTIVO_DA_PERDA_FORA_DO_VOCABULARIO, input.idioma ?? IDIOMA_PADRAO),
  };
}
