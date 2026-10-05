/**
 * "ENVIAR AVISO DE TESTE" — a prova de que a configuração funciona, mandando de
 * verdade.
 *
 * ## Por que reusar o motor a partir do passo 8, e não escrever um envio novo
 *
 * O que quebra o aviso não é o envio: é a fila de condições ANTES dele — canal
 * arquivado, canal que só manda modelo aprovado, canal parado, endereço público
 * ausente, transporte fora do ar, teto do aquecimento, destino que o canal não
 * sabe endereçar. Um "teste" que pulasse essa fila ficaria verde exatamente nas
 * instalações em que o aviso nunca vai sair — que é o pior desfecho possível
 * para um botão que existe para dar certeza.
 *
 * Por isso este arquivo repete a ORDEM do motor (`aviso-ao-suporte.ts`, passos
 * 8 → 15, inclusive o 11b — o destino que voltou a ser número de uma conexão
 * ativa da organização) e reusa as MESMAS portas (`AvisoDb`, `TransporteDoAviso`,
 * `PacingDoAviso`). O que ele não repete são os dois passos que só fazem
 * sentido com um caso: a reivindicação da entrega e a linha do tempo.
 *
 * ## O que ele NÃO escreve, e o que ele escreve
 *
 * **Não** grava em `entregas_de_aviso_de_caso`. A `unique` de lá é
 * `(organization_id, case_id, destino)` e `case_id` é FK para `agent_cases`:
 * não existe caso sintético que caiba ali sem inventar uma linha em
 * `agent_cases` ou queimar a entrega de um caso real. As deps deste módulo
 * sequer expõem as funções de escrita da entrega — a impossibilidade é
 * estrutural, não disciplinar.
 *
 * **Grava** no `pacing_ledger`. A mensagem saiu pelo número da organização e
 * gastou uma do dia; num número em aquecimento o teto é 20. Cinco conferências
 * não contadas somem do teto e represam o 21º aviso REAL por uma conta que o
 * produto não fez. O preço aparece na tela antes do clique.
 *
 * ## Nenhum desfecho lança
 *
 * A rota precisa transformar cada recusa numa frase de gente. Um `throw` aqui
 * viraria 500 com stack, e quem opera leria "erro inesperado" sobre a única
 * coisa que ele queria saber — por que o aviso não sai.
 */
import type { AvisoDb, CanalDoAviso, PacingDoAviso, TransporteDoAviso } from "./aviso-ao-suporte";
import { mascara } from "./aviso-ao-suporte";
import { montarAvisoDeTeste } from "./texto-do-aviso";
import { urlPublicaUsavel } from "./url-publica";
import type { ErroDaEntregaDeAviso } from "./vocabulario-do-aviso";

/**
 * As deps são um RECORTE de `AvisoDeps`, e o recorte é a prova.
 *
 * `db` traz só as três leituras que o teste precisa. Passar o `AvisoDb`
 * completo devolveria a garantia de "não escreve na entrega" ao terreno do
 * "confia que ninguém vai chamar" — e o caso de teste que mede isso mede as
 * CHAVES deste objeto, não a ausência de uma linha.
 */
export interface DepsDoAvisoDeTeste {
  db: Pick<AvisoDb, "carregaCanal" | "marcaDaOrganizacao" | "destinoEhDaPropriaOrganizacao">;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  /** `env.NEXT_PUBLIC_APP_URL` já lido pelo chamador — este módulo não importa `env`. */
  urlPublica: string;
}

/**
 * Por que o motivo do teste NÃO é exatamente `ErroDaEntregaDeAviso`.
 *
 * `espacamento` não existe naquela tupla de propósito: no motor ele vira
 * `retry` e some, porque não é uma entrega que falhou — é o anti-ban pedindo
 * 1,2 s. Aqui ele precisa de nome, porque há alguém olhando a tela esperando
 * uma resposta. Acrescentá-lo ao vocabulário da tabela seria pior: aquele
 * conjunto espelha o CHECK do banco, é guardado por invariante, e um valor que
 * nenhuma linha jamais grava é vocabulário morto.
 */
export type MotivoDoTeste = ErroDaEntregaDeAviso | "espacamento";

export type ResultadoDoAvisoDeTeste =
  | { enviado: true; destinoMascarado: string; externalId: string | null }
  | {
      enviado: false;
      codigo: MotivoDoTeste;
      /** ISO do instante em que o número volta a poder enviar, quando se sabe. */
      liberaEm?: string;
      /** A causa crua do transporte, TRUNCADA. Nunca vai para auditoria. */
      detalhe?: string;
    };

function recusa(
  codigo: MotivoDoTeste,
  extra: { liberaEm?: string; detalhe?: string } = {},
): ResultadoDoAvisoDeTeste {
  return { enviado: false, codigo, ...extra };
}

export async function enviarAvisoDeTeste(
  deps: DepsDoAvisoDeTeste,
  entrada: { organizationId: string; channelSessionId: string; telefone: string },
): Promise<ResultadoDoAvisoDeTeste> {
  const agora = deps.clock();
  const { organizationId: orgId, channelSessionId, telefone } = entrada;

  // ── 8. O canal ───────────────────────────────────────────────────────────
  let canal: CanalDoAviso | null;
  try {
    canal = await deps.db.carregaCanal(orgId, channelSessionId);
  } catch {
    // Leitura que falhou não é canal arquivado. `indeterminado` é a resposta
    // honesta, e a frase dele diz exatamente isso a quem opera.
    return recusa("indeterminado");
  }
  if (!canal || canal.archived_at) return recusa("canal_arquivado");
  if (canal.desativado) return recusa("canal_desativado");
  if (!canal.aceitaMensagemLivre) return recusa("canal_nao_aceita_aviso_livre");
  // No motor, canal parado vira `retry` por até ~30 min. Aqui não: há alguém
  // esperando a resposta na tela, e "vou tentar de novo em 5 minutos" não é
  // resposta para quem clicou um botão chamado "enviar agora".
  if (canal.status !== "WORKING") return recusa("canal_desconectado");

  // ── 9. O link precisa abrir no celular de outra pessoa ───────────────────
  if (!urlPublicaUsavel(deps.urlPublica)) return recusa("sem_endereco_publico");

  // ── 10. O transporte desta instalação está de pé? ────────────────────────
  if (!(await deps.transporte.configurado(orgId, canal))) return recusa("transporte_ausente");

  // ── 11. Espaçamento e teto diário — o mesmo anti-ban do aviso real ───────
  const pacing = await deps.pacing.decide(orgId, channelSessionId, agora);
  if (!pacing.liberado) {
    return recusa(pacing.motivo === "teto_diario" ? "teto_diario_do_numero" : "espacamento", {
      liberaEm: pacing.liberaEm.toISOString(),
    });
  }

  // ── 11b. O destino ainda é de fora? — a mesma pergunta do motor ─────────
  // Sem ela, depois de reativar a conexão cujo número é o destino, o teste
  // mandaria para um número da própria conta e apareceria verde enquanto o
  // aviso real é recusado — o desfecho que este módulo existe para evitar.
  let destinoProprio: boolean;
  try {
    destinoProprio = await deps.db.destinoEhDaPropriaOrganizacao(orgId, telefone);
  } catch {
    return recusa("indeterminado");
  }
  if (destinoProprio) return recusa("destino_da_propria_organizacao");

  // ── 12. O destino ────────────────────────────────────────────────────────
  const to = await deps.transporte.resolveDestino(orgId, canal, telefone);
  if (!to) return recusa("destino_invalido");

  // ── 13. O texto ──────────────────────────────────────────────────────────
  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const body = montarAvisoDeTeste({
    marca: marca.nome,
    idioma: marca.idioma,
    link: `${deps.urlPublica.replace(/\/+$/, "")}/app/ai/cases`,
  });

  // ── 14. O transporte ─────────────────────────────────────────────────────
  let externalId: string | null = null;
  try {
    const resposta = await deps.transporte.envia(orgId, canal, to, body);
    externalId = resposta.externalId;
  } catch (err) {
    const causa = err instanceof Error ? err.message : String(err);
    return recusa("falha_no_envio", { detalhe: causa.slice(0, 300) });
  }

  // ── 15. Saiu: o número pagou por ela ─────────────────────────────────────
  // Falha ABERTA, como no motor: a mensagem já está no celular de alguém, e
  // derrubar a rota depois do envio faria a pessoa clicar de novo.
  await deps.pacing.registraEnvio(orgId, channelSessionId, agora);

  // O destino volta MASCARADO. Quem clicou é admin e conhece o número, mas a
  // resposta de uma rota entra em log de proxy e fica numa aba aberta.
  return { enviado: true, destinoMascarado: mascara(telefone), externalId };
}
