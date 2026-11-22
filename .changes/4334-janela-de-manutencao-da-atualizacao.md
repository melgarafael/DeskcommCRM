---
impacto: capacidade_nova
secao: adicionado
titulo: A atualização pedida pela tela pode esperar uma janela de manutenção, e o painel e a volta automática continuam de plantão
---

Quem opera em horário comercial não queria a instalação ~5 minutos em manutenção
no meio do expediente. Agora o `.env` aceita `SYSTEM_UPDATE_WINDOW` com os cinco
campos de um horário de cron (minuto hora dia mês dia-da-semana, os três últimos
em `*`) e a atualização pedida pela tela só executa dentro dela; por exemplo
`SYSTEM_UPDATE_WINDOW=*/5 2-5 * * *` restringe à madrugada. Pedido feito fora da
janela não se perde: fica pendente e roda quando ela abrir.

O que **não** muda: o agente continua rodando de 5 em 5 minutos, o batimento ao
painel continua acontecendo o dia inteiro (a tela segue sabendo da versão
instalada e de que há atualização esperando) e a vigília que devolve a versão
anterior sozinha, se o app não subir, nunca é segurada pela janela. Sem a chave
no `.env`, nada muda: a atualização roda assim que for pedida, como sempre foi.
Valor inválido é recusado em voz alta no log do servidor e a janela fica aberta,
para uma digitação errada não deixar a instalação sem atualizar. Isso inclui o
minuto que nunca cai numa rodada do agente (que roda em :00, :05, :10…): `1 2 * * *`
é recusado, porque a janela nunca abriria.

Enquanto o pedido espera, ele é reconhecido como **agendado**: a tela de
atualização diz "Atualização agendada para 02h00", sem o botão de pedir de novo
e sem o falso "perdi contato com o servidor" depois de 15 minutos; um segundo
pedido feito enquanto isso (de outra aba ou pela API) recebe a resposta de que o
agendamento segue de pé, em vez de cancelá-lo; e a instalação, atualização e publicação de extensões continuam bloqueadas até a
atualização rodar, como já eram durante uma atualização em curso.

A janela é lida no relógio do fuso `SYSTEM_UPDATE_WINDOW_TZ` (nome IANA), com
`America/Sao_Paulo` quando a chave não existe, e não no fuso do servidor, que
numa VPS nova costuma ser UTC. Para conferir a hora que vale:
`TZ=America/Sao_Paulo date`.

Contribuição de @webtecnica (#4334, #4504). O estado agendado, o fuso e a recusa do
minuto fora das rodadas foram feitos pelos mantenedores, sobre o desenho de
@webtecnica.
