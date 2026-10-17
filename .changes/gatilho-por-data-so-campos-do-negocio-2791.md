---
impacto: nada_mudou
secao: corrigido
titulo: O gatilho "faltam N dias para uma data do funil" não oferece mais campo do contato, que nunca disparava
---

Depois que os campos do funil passaram a poder ser do contato, um campo de data marcado como Contato (ex.: Nascimento) aparecia como opção de "Campo de data" no editor de regras e no Designer de automações. A varredura diária lê a data no negócio, e o valor de um campo do contato fica gravado no contato: a regra era salva e nunca disparava, sem aviso. Agora os dois seletores oferecem só campos de data do negócio, como o calendário do funil já fazia, e o servidor recusa salvar ou religar, pela tela, pela API ou pelo assistente, uma regra desse gatilho apontada para um campo do contato, com a frase "Este campo de data é do contato, e o gatilho por data só lê campos do negócio. Escolha um campo de data do negócio." Desligar ou renomear segue liberado.

Nas configurações do funil, marcar como Contato um campo que uma regra ligada desse gatilho já usa também passou a ser recusado: a mensagem nomeia as regras e pede para trocar o campo delas ou desligá-las antes. O que ainda não é barrado: uma regra antiga que já estivesse ligada sobre um campo do contato continua ligada e sem disparar, e a frase só aparece quando alguém edita o gatilho ou religa a regra. Nesse caso, troque o campo da regra por um campo de data do negócio.

Achado na prova do #2852 de @webtecnica (refs #2791).
