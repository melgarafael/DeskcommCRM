/**
 * A TELA DO AGENTE DIZ POR QUE A IA PUBLICADA NÃO RESPONDE (#3976).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Todo canal nasce em **modo de teste com a lista vazia**
 * (`metadataInicialDoCanal`, `./pre-go-live.ts`), e com a lista vazia o gate
 * devolve `fora_da_lista_de_teste` para QUALQUER contato (`./gate.ts`, ramo do
 * pré-go-live). A pessoa publica o agente, escolhe o número, manda mensagem do
 * próprio celular e nada acontece — e a tela onde ela configura e publica
 * mostrava o número, o telefone e o estado da conexão, tudo certo. O único
 * aviso do produto morava no cartão do canal em Conexões, que é justamente a
 * tela que ela não abre quando o sintoma aparece no agente.
 *
 * ─── Por que a regra é um módulo puro ───────────────────────────────────────
 *
 * Só existem três frases possíveis e o custo de errar é de CONFIANÇA: dizer
 * "está tudo em ordem" para um canal que não responde é o defeito original;
 * dizer "seu número não está autorizado" para um canal aberto, ou para um
 * número que ESTÁ na lista, ensina a pessoa a mexer no que não está quebrado.
 * A decisão sai daqui, sem React e sem banco, e os dois lugares que a mostram
 * (o cartão "Número conectado" do editor e o painel de teste) chamam a MESMA
 * função — a tela não pode divergir do que o gate faz.
 *
 * ─── O que NÃO se afirma ────────────────────────────────────────────────────
 *
 * `mode` ou `testNumbersCount` nulos são estado NÃO MEDIDO (leitura falhou,
 * permissão negada), e não viram "modo de teste": a mesma régua do #3975 —
 * indefinido não acusa. E o número de quem testou só é comparado quando a tela
 * o conhece e ele vem com DDI; palpite sobre o número seria uma segunda
 * invenção em cima da primeira.
 */
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";

import { AI_GATE_PRE_GO_LIVE, type AiAccessMode, numeroPodeTestar } from "./pre-go-live";

/**
 * O retrato do acesso da IA a UM canal, como a tela do agente o recebe.
 *
 * `testNumbersCount` é CONTAGEM, nunca a lista: os números de teste são PII e a
 * rota que os devolve exige administrador (`/api/v1/channel-sessions/[id]/ai-access`).
 * Basta a contagem para distinguir "ninguém autorizado" de "há números".
 */
export interface AcessoDaAiDoCanal {
  mode: AiAccessMode | null;
  testNumbersCount: number | null;
}

export type AvisoDoModoDeTeste =
  /** Nada a dizer: canal aberto, número autorizado, ou estado não medido. */
  | { tipo: "nenhum" }
  /** Modo de teste sem NINGUÉM autorizado: a IA não responde a ninguém. */
  | { tipo: "lista_vazia" }
  /** Modo de teste com lista, e o número de quem testa está fora dela. */
  | { tipo: "numero_fora_da_lista"; numero: string };

/**
 * O número que a tela conhece, em forma comparável — ou `null` quando não dá
 * para comparar sem chutar.
 *
 * Só entra número com DDI. `+5511...` (como o campo ensina) ou 12+ dígitos que
 * já trazem o país; um "99999-8888" digitado sem DDI viraria `+999998888`, que
 * não casa com nada e acusaria um número que pode estar na lista.
 */
function numeroComparavel(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const texto = bruto.trim();
  if (texto === "") return null;
  const digitos = texto.replace(/\D/g, "");
  const temDdi = texto.startsWith("+") || digitos.length >= 12;
  if (!temDdi) return null;
  const discavel = parseDialablePhone(texto);
  if (discavel === null) return null;
  return canonicalPhoneBR(discavel);
}

/**
 * O canal está em modo de teste, com o estado MEDIDO.
 *
 * Existe para a tela não escrever o literal do vocabulário do banco: uma cerca
 * (`tests/unit/passagem-motivo-em-portugues.test.ts`) reprova código cru do
 * vocabulário em `app/`, `components/` e `hooks/`, e ela está certa — o código
 * existe para a constraint recusar lixo, não para alguém ler.
 */
export function canalEmModoDeTeste(acesso: AcessoDaAiDoCanal | null): boolean {
  return acesso !== null && acesso.mode === AI_GATE_PRE_GO_LIVE;
}

/**
 * A decisão, para um canal (e, quando conhecido, para o número em teste).
 *
 * Ordem importa: o "não medido" vem primeiro porque é o único desfecho que não
 * pode ser confundido com um diagnóstico.
 */
export function decidirAvisoDoModoDeTeste(entrada: {
  acesso: AcessoDaAiDoCanal | null;
  /**
   * Os números autorizados, quando a tela TEM permissão para lê-los. Ausente ou
   * `null` = não lidos — aí não se afirma que o número está fora da lista.
   */
  numerosDeTeste?: readonly string[] | null;
  /** O número de quem está testando, quando a tela o conhece. */
  numeroEmTeste?: string | null;
}): AvisoDoModoDeTeste {
  const acesso = entrada.acesso;
  if (!acesso || acesso.mode === null || acesso.testNumbersCount === null) {
    return { tipo: "nenhum" };
  }
  // `allowlist` legado (autorização por origem) não é modo de teste: o gate
  // exige autorização positiva do contato, e a frase do aviso seria outra.
  if (acesso.mode !== AI_GATE_PRE_GO_LIVE) return { tipo: "nenhum" };

  if (acesso.testNumbersCount === 0) return { tipo: "lista_vazia" };

  const numero = numeroComparavel(entrada.numeroEmTeste);
  if (numero === null) return { tipo: "nenhum" };

  const autorizados = entrada.numerosDeTeste;
  if (!autorizados || autorizados.length === 0) return { tipo: "nenhum" };

  return numeroPodeTestar(numero, autorizados)
    ? { tipo: "nenhum" }
    : { tipo: "numero_fora_da_lista", numero };
}
