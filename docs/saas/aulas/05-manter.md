# Aula 5 · Manter: custo, atualizar, backup e contrato

**Entrega:** o aluno sabe quanto cada cliente custa, atualiza o sistema sem medo, tem backup
fora da VPS e um roteiro de contrato para levar ao advogado.
**Guias de referência:** [`../README.md`](../README.md), etapa 7; [`../coolify.md`](../coolify.md),
Atualizar e Backup; [`../contrato-e-lgpd.md`](../contrato-e-lgpd.md).

## Cenas

1. **Quem paga a IA:** chave do cliente (BYOK) contra chave da instalação, e o orçamento mensal
   de cada empresa, que começa sem limite.
2. **O painel Usage:** custo por empresa e a planilha exportada.
3. **Atualizar pelo botão:** o rodapé "Nova versão", a tela "Atualizar agora", o "Pedido
   enviado — esperando o servidor pegar" (até 5 minutos) e a volta, com cerca de 30 segundos
   fora do ar. Depois, o `307` em `/app`.
4. **Atualizar pelo terminal**, para quando o botão não estiver à mão.
5. **O que não fazer no Coolify:** não atualizar o CRM pelo painel dele e deixar Unused volumes
   e Unused networks em **Keep** na faxina.
6. **Backup:** rodar à mão, agendar, e levar dados e chaves para fora da VPS por caminhos
   diferentes.
7. **Contrato e LGPD:** controlador e operador, as cláusulas, e o jeito certo de falar da ANPD.

## O erro que vale mostrar

A faxina do Coolify com Unused volumes marcado: mostre a tela e explique o que ela apagaria,
**sem** executar.

## Tarefa do aluno

Um backup rodado à mão, o agendamento conferido no dia seguinte
(`ls -lt ~/deskcommcrm/backups | head`) e a planilha de custo por cliente preenchida.
