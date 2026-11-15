---
impacto: capacidade_nova
secao: alterado
titulo: Prospecção baixa a lista completa da campanha, com a situação de cada empresa
---

Em Prospecção, o botão **Baixar lista** do cartão da campanha agora abre um menu com duas opções. **Só as não abordadas** é o arquivo de sempre. **Todas** traz a lista inteira da campanha, com uma coluna `situacao` no fim que diz o que aconteceu com cada empresa: respondeu, abordada (só quando o envio foi confirmado), envio não confirmado, não abordada ou fora da fila (a empresa foi pulada antes da abordagem, por exemplo porque já era contato do CRM ou não tem WhatsApp). O botão aparece em toda campanha que tem empresas, inclusive na concluída; antes ele sumia quando todas já tinham sido abordadas. Cada vez que o menu abre, a tela conta de novo quantas empresas cada lista leva e quantas ficam de fora; enquanto conta, ou se não conseguir contar, as duas opções ficam desabilitadas, mesmo que uma contagem anterior tenha dado certo. Nenhuma das duas listas traz quem pediu para parar, contatos pessoais ou quem teve os dados apagados, e isso agora vale também para a lista de sempre. Esses contatos são achados também pelo telefone da empresa, não só pelo vínculo com a campanha. A lista completa sai no formato da importação. Ao importá-la de volta, a coluna `situacao` é ignorada, e quem já é contato do CRM continua sendo recusado, como em qualquer importação. Cada download fica registrado na auditoria com a lista escolhida e as contagens, nunca com o conteúdo.

Crédito: @tabaterral, que escreveu a lista completa, a coluna `situacao` e a régua de quem nunca sai no arquivo (#4651).
