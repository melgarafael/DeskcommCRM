/**
 * Abre a janela anti-ban para os invariantes que NÃO são sobre a janela.
 *
 * Desde que o turno do agente passou a ADIAR fora da janela (7h–22h por padrão,
 * `inbound-turn.ts`), todo teste que faz o agente falar com o lead passou a
 * depender do RELÓGIO DA MÁQUINA — e a falhar à noite, com uma mensagem que não
 * tem nada a ver com o que ele mede:
 *
 *     expected 'fora da janela anti-ban — job reagend…' to match /credencial LLM/
 *
 * MEDIDO em 2026-08-25: o CI da `main` (SHA bc079649, sem nenhuma alteração)
 * passou às 23:28 UTC e o RERUN do MESMO commit às 01:46 UTC reprovou com 8
 * falhas — as mesmas 8 de um PR que só tocava shell e markdown. Conjunto
 * idêntico, arquivo e linha: a diferença entre verde e vermelho era a hora.
 * Na prática, `invariants` é status check obrigatório, então ninguém conseguia
 * fazer merge à noite — e cada PR noturno acusava o autor de ter quebrado algo.
 *
 * O adiamento é CORRETO em produção e não se conserta lá: o lead que escreve
 * 22h56 tem de receber resposta às 7h, e não um silêncio. Quem está errado é o
 * fixture, que herda o default 7h–22h e por isso mede uma coisa de dia e outra
 * de noite.
 *
 * A janela é um KNOB por canal (`channel_knobs`, coluna NULL = default do
 * código), então abrir 0–24 no fixture é usar o mecanismo que já existe — não
 * furar o comportamento. Testes que medem A JANELA continuam definindo os
 * próprios knobs e não chamam isto.
 */
import type { Pool } from "pg";

/**
 * Deixa a janela de envio SEMPRE aberta para este canal — 0h–24h, domingo
 * incluído, em UTC. Idempotente: pode ser chamada em `beforeAll` que re-roda.
 *
 * O timezone é fixado em UTC de propósito: com 0–24 a hora local não muda mais
 * o veredito, e deixar o default (fuso do tenant) faria o teste depender de
 * qual máquina o roda.
 */
export async function abreJanelaDeEnvio(
  pool: Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<void> {
  await pool.query(
    `insert into channel_knobs
       (organization_id, channel_session_id, window_start_hour, window_end_hour, allow_sunday, timezone)
     values ($1, $2, 0, 24, true, 'UTC')
     on conflict (organization_id, channel_session_id) do update
       set window_start_hour = 0,
           window_end_hour   = 24,
           allow_sunday      = true,
           timezone          = 'UTC'`,
    [organizationId, channelSessionId],
  );
}
