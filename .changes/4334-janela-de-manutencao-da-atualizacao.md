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
para uma digitação errada não deixar a instalação sem atualizar.

Contribuição de @webtecnica (#4334).
