# Agendas de serviços

A expansão é opt-in sobre `calendar_event_types` e `calendar_appointments`. Cada pessoa mantém sua reserva; a ocorrência coletiva ocupa profissional/recurso uma vez. A consulta não comprova reserva, e reserva não comprova comunicação ou publicação Google.

## Caminhos reais

- Configurações da Agenda → **Serviço e horários** → `POST /api/v1/agenda/servicos`: gerente atual, organização e revisão. Programação semanal e exceção em uma data são distintas; exceções não dispensam bloqueios/conflitos. Reservas existentes permanecem. Recursos podem ser criados/alterados, sem apagar reservas.
- Inbox → **Reservar serviço** → consulta → pessoas pedidas → escritor compartilhado `POST /api/v1/agenda/agendamentos`. O grupo inteiro é reservado na transação ou nenhuma pessoa é criada. A sessão humana usa a porta autenticada `fn_appointment_change`; RPCs internas continuam restritas ao servidor.
- Agenda → **Turmas e reservas coletivas**: agrupamento pela ocorrência persistida; remarcação/cancelamento afetam a pessoa escolhida. Teto de consulta e regra guardada na reserva são visíveis. Tipos sem opt-in preservam jornada individual, opção sobre colegas e encaixe humano anteriores.

## Google e revisão

A publicação usa somente CRM, calendário compartilhado do serviço ou calendário do profissional atribuído. O titular vem da conexão real; turma sem profissional não precisa de responsável fictício. Claims/leases/revisão/ETag/intenção/evento estável/reconciliação nativos são preservados. Rede fica fora da transação. A cópia gerenciada é reconhecida pela tupla persistida organização/conexão/calendário/evento, nunca por título/prefixo. Revogação, acesso e cobertura são conferidos. Fontes do serviço usam crons existentes, sem alterar escolhas globais pessoais. Alterar o destino não transfere reservas já publicadas.

Uma edição remota precisa respeitar programação, duração e estoque. A recusa conserva a reserva original e gera conflito visível, sem declarar sincronização de horários diferentes. Cancelar uma reserva existente não exige disponibilidade para uma nova entrada. Eventos de bloqueio não alteram o alcance do bloqueio local: o operador retira ou ajusta o bloqueio pela porta própria. A exceção de capacidade do horário permanece ao alternar entre os dois modos coletivos.

O coletor factual lê somente reservas do contato/conversa atuais, com participante, estado, regra guardada, revisão atual e publicação verificável. A projeção factual local é compartilhável por consumidores, mas esta contribuição não altera o runtime de revisão, os consentimentos ou os provedores. A integração com revisores pertence à contribuição dependente. Outros participantes da turma não vão ao contexto desse contato.

## Provas e limites

`regras.test.ts` cobre fuso/programação/duração/capacidade. `agenda-servicos.test.ts` usa PostgreSQL real para capacidade durante todo o intervalo, corrida, grupo atômico, dedup, remarcação/cancelamento, profissional/recurso coletivo, bloqueios, cobertura, duas organizações e criação autenticada. `agenda-servicos-update.test.ts` reaplica o baseline com turma já reservada e confere preservação e exclusividade individual. A deduplicação histórica do baseline não desloca participantes de turma.

As cercas existentes de RLS e definer permanecem sem afrouxamento. Regressões de MCP, ferramenta conjunta, horários locais, colegas, encaixe, contexto, Inbox e i18n cobrem as integrações afetadas. Provas isoladas não demonstram precisão universal de modelos, entrega externa ou publicação real. Gates completos, build normal, UI autenticada e integração dirigida continuam necessários antes da promoção; o protótipo não é prova do CRM.

`agenda-servicos.spec.ts` usa sessão e PostgREST reais para painel/Inbox, capacidade por horário e agrupamento. Seu caso de Google compartilhado injeta somente o transporte HTTP: a máquina real de claims/intenção/ETag recupera resposta perdida sem novo evento, preserva a identidade na remarcação, aceita mudança remota válida, sinaliza duração incompatível, permite escolha autenticada e cancela mesmo quando o horário está bloqueado. O receptor sintético não comprova a disponibilidade do provedor real.

Depois de haver coletivas, a reversão conserva schema e processador compatíveis. Desativar novas entradas e corrigir para frente é seguro; voltar indiscriminadamente a imagem que desconhece coletivas não é reversão comprovada. Backup próprio/manifesto de imagens precedem a promoção; restore de banco não é automático.

## Sistema Vivo — artefatos

1. Entrada: ator/revisão atuais, programação e fontes de `fn_calendar_service_check`.
2. Saída: handlers REST/MCP, prévia, recibos, crons e contexto factual.
3. Registro: atividade/`fecharOLaco` e audit nativos; audit da configuração e estado Google persistido.
4. Tela: `ConfiguracaoDoServico`, `ReservarServicoNaConversa`, `ReservasColetivas`.
5. Porta: Configurações da Agenda, Inbox e Agenda existentes.
6. Anti-morte: retry/conflito Google e comunicação pelo Caso existente; consulta pura não requer follow-up.
7. Configuração: formulário condicional e prévia com motivo; configuração incompleta não vira vaga.
8. IA↔humano: fatos comuns e autoria real; texto livre não vira execução.
9. Retorno: recusa/revisão pede reconsulta; reconexão/conciliação altera disponibilidade futura. Veto não cria outra reserva.
10. Mapa: configuração/escrita/inventário/contexto têm entrada e saída no mapa de reconciliação Google.
