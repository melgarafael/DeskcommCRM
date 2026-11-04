/**
 * O ORÇAMENTO de tempo do servidor MCP externo dentro de um TURNO de atendimento
 * (#3586).
 *
 * ── Por que um número do turno, e não o default do cliente ──────────────────
 *
 * `chamada.ts` fecha tudo em `TIMEOUT_PADRAO_MS = 15_000`, e o mesmo valor vale
 * para as DUAS operações de cada passo (`connect` e `listTools`/`callTool`). Num
 * turno isso não é "15 s": é até 30 s por operação, multiplicado por quantas
 * ferramentas remotas o modelo chamar. Um ERP mudo (firewall, DNS preto, deploy
 * travado) não pode gastar o turno inteiro: quem está do outro lado é um
 * cliente esperando resposta no WhatsApp, e o turno ainda precisa responder.
 *
 * O caminho do CADASTRO — "Testar conexão" e a lista do editor — continua com os
 * 15 s de `chamada.ts`: ali quem espera é o administrador, olhando uma tela, e
 * um servidor lento merece o benefício da dúvida. O turno não tem essa folga.
 *
 * ── Por que 8 s ────────────────────────────────────────────────────────────
 *
 * Uma leitura de estoque/agenda é uma consulta indexada do outro lado: p99 na
 * casa de 1–2 s, e o que passa disso é fila ou servidor doente. 8 s dá ~4× de
 * folga sobre o p99 e corta o pior caso de 30 s para 8 s por passo — com três
 * ferramentas remotas num turno, 24 s em vez de 90 s. Acima disso a resposta
 * certa é "não consegui consultar agora", não fazer o cliente esperar.
 *
 * Vale para o servidor da organização (`carregar.ts`, `definirFerramentasRemotas`)
 * e para os do agente (`do-agente/carregar.ts`, `definirFerramentasDoServidorDoAgente`).
 */
export const TIMEOUT_DA_DESCOBERTA_NO_TURNO_MS = 8_000;

/** Teto de UMA chamada `tools/call` no turno — ver o cabeçalho. */
export const TIMEOUT_DA_CHAMADA_NO_TURNO_MS = 8_000;
