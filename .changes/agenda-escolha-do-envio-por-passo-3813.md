---
impacto: capacidade_nova
secao: adicionado
titulo: Cada passo que envia escolhe o que fazer quando o contato tem horário marcado
---

A proteção da agenda segurava **todo** envio automático de quem tinha um atendimento marcado, sem escolha por regra nem por fluxo. Na clínica, isso atrasava o que não é cobrança: a paciente saía do procedimento com o retorno já marcado para 14 dias depois e só recebia os cuidados no dia do retorno; os parabéns de aniversário saíam no dia da consulta seguinte; o aviso de manutenção chegava para quem tinha acabado de fazer a sessão.

Agora cada passo que envia — a mensagem de WhatsApp e a mensagem escrita pela IA, dentro da automação — tem a escolha «Quando o contato tiver horário marcado», com três respostas e o efeito escrito embaixo de cada uma:

- **Adiar e enviar depois do horário** (padrão): a mensagem espera o atendimento e sai logo depois;
- **Enviar mesmo assim**: sai na hora, mesmo com atendimento marcado — o caso do pós-atendimento e do aniversário;
- **Não enviar**: a mensagem não sai e o pulo fica registrado na aba Atividade com o motivo «contato com horário marcado», em vez de desaparecer em silêncio.

A escolha é por passo, então a mesma regra pode adiar o lembrete de cobrança e mandar o pós-atendimento na hora. Em qualquer das três continuam valendo o descadastro do contato, a janela de envio do número e o limite diário.

Nada muda para quem já usa o sistema: a automação que nunca configurou a escolha continua adiando exatamente como antes, e abrir e salvar a regra não grava escolha nenhuma. Nenhuma migração é necessária.

Contribuição de @webtecnica (#3864).
