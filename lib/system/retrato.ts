/**
 * A IDADE DO RETRATO DO HOST — o que separa "conferi agora" de "parei de
 * conferir há horas".
 *
 * ## O defeito que este arquivo existe para impedir (#3488)
 *
 * `system_version` guarda o ÚLTIMO retrato que o heartbeat do host conseguiu
 * gravar — não o estado do servidor. Nada nele carregava a idade da informação:
 * `latest_version` vazio, `compare_failed` falso e `has_known_release`
 * verdadeiro é, ao mesmo tempo, o estado de "conferi agora e está tudo em dia"
 * e o de "parei de conferir há horas e não sei de nada".
 *
 * Medido em produção em 26/10/2026, instalação self-host: o `systemd-resolved`
 * subiu sem upstream e o agente ficou 51 batidas seguidas sem conseguir postar
 * (11h45 → 16h04). A v1.90.0 saiu às 14h07. Às 16h o operador abriu a tela e
 * leu *"Você está na versão v1.89.0 — É a mais recente. Não há nada a fazer."*
 * A máquina de estados estava certa; o que faltava era envelhecer o retrato.
 *
 * A única válvula de dúvida era `agent_online` (24h), então uma VPS podia
 * passar quase um dia inteiro afirmando isso com dado de horas atrás — e o
 * painel é a única fonte que o operador consulta.
 *
 * ## Por que 30 minutos (e não 5, e não 24h)
 *
 * Os dois vizinhos desta régua, medidos:
 *
 *   - O agente bate de 5 em 5 minutos. Uma régua de uma batida piscaria "não
 *     sei" entre duas batidas normais.
 *   - Durante uma atualização o app responde `{"code":"maintenance"}` e o
 *     heartbeat NÃO grava (8 ocorrências no log da instalação que abriu a
 *     issue, entre 15 e 24/10). O `update.sh` leva ~2 min e o agente ainda
 *     tenta reportar por mais alguns depois do reinício.
 *   - 24h é a válvula antiga, e é o caso extremo: quando ela abre, o retrato já
 *     está velho faz tempo.
 *
 * 30 min = 6 batidas perdidas: folgado para uma atualização inteira (inclusive
 * a janela de `maintenance`), e curto o bastante para o operador desconfiar na
 * mesma tarde em que o host parou de falar.
 */
export const RETRATO_VELHO_APOS_MS = 30 * 60 * 1000;

/**
 * O retrato que a tela lê é velho demais para afirmar qualquer coisa?
 *
 * `true` também quando nunca ouvimos o host (nulo, ausente, data inválida):
 * não há retrato para envelhecer, e um retrato que não existe não sustenta
 * afirmação nenhuma. Quem decide o texto desse caso é `agent_online`, que já
 * cai no mesmo instante — a régua aqui não depende dele para ser conservadora.
 */
export function retratoDoHostVelho(
  lastSeenAt: string | null | undefined,
  now: Date,
): boolean {
  const visto = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (Number.isNaN(visto)) return true;
  return now.getTime() - visto > RETRATO_VELHO_APOS_MS;
}
