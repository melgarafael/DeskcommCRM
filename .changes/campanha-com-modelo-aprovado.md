---
impacto: capacidade_nova
secao: adicionado
titulo: Campanhas pelo número oficial, com modelo aprovado
---

Número oficial (API da Meta, direto ou por provedor parceiro) só aceita texto
livre para quem escreveu nas últimas 24 horas — e campanha fala justamente com
quem não escreveu. Por isso a campanha num número oficial falhava em cada envio.

Agora, ao escolher um número oficial em **Campanhas › Nova campanha**, o campo de
texto dá lugar aos **modelos aprovados daquele número**, com a categoria de cada
um, a prévia como o cliente vai ver (cabeçalho, corpo, botões, imagem) e, para
cada variável (`{{1}}`, `{{2}}`…), de onde sai o valor: primeiro nome, nome
completo, um campo do negócio ou um texto fixo. Quem não tiver o dado fica fora
da lista com o motivo, como já acontecia no texto livre. O modelo não se cria no
formulário: um link leva para a tela de modelos de Conexões, e o botão
**Atualizar lista** traz o que a plataforma aprovou.

Cada mensagem sai pelo mesmo envio do resto do sistema e fica na conversa com o
texto completo, então o assistente sabe o que o cliente está respondendo. No
detalhe da campanha, quem falhou mostra o motivo da plataforma em frase
(desligou o marketing da empresa, passou do limite de promoções, não tem
WhatsApp). Quem desligou o marketing sai das próximas campanhas. Se o modelo for
pausado pela plataforma, o número for restringido ou faltar pagamento, a
campanha **pausa sozinha** com o motivo, em vez de repetir a mesma falha em todo
mundo. No número oficial a campanha não usa o aquecimento anti-banimento do
número por QR; o horário, os tetos e o intervalo da campanha continuam valendo.

Nesta versão a campanha com modelo sai por um número só. Crédito: @jmpo.
