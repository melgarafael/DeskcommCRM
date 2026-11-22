---
impacto: capacidade_nova
secao: adicionado
titulo: A campanha de prospecção pode rodar só no horário dela, e pausa e retoma sozinha
---

Quem usa um número só para dois nichos — um de manhã, outro à tarde — pausava
uma campanha e retomava a outra a cada troca, à mão. Agora a campanha ganha,
opcionalmente, "rodar só entre X e Y" (dias da semana e horas cheias, no fuso da
organização). Fora do horário dela a campanha pausa pelo mesmo caminho da tela e
volta sozinha na abertura seguinte; dentro dele, dispara normalmente.

AS DUAS JANELAS SE CRUZAM, NÃO SE SUBSTITUEM. A janela do NÚMERO — dias próprios
da prospecção, horas de disparo, aquecimento, teto diário e intervalo — continua
valendo exatamente como antes, e é ela que decide o ritmo. Só dispara onde as
duas estão abertas: fora da janela da campanha nada sai, nem tentativa nem
candidato marcado, e a fila espera a próxima abertura.

A TRAVA DE UMA CAMPANHA POR NÚMERO CONTINUA. Se a janela de uma campanha abrir
enquanto outra estiver rodando no mesmo número, ela não retoma: fica pausada com
o motivo escrito no cartão ("o número está com outra campanha em andamento") e
volta sozinha quando o número ficar livre. Pausa manual, arquivamento e início
limpam a marca da pausa automática — campanha que uma pessoa pausou não volta
sozinha nunca.

O teto diário e o intervalo do número não mudaram de lugar: continuam contando
por NÚMERO, somando o que todas as campanhas dele já tentaram nas últimas 24 h.
Com uma campanha rodando por vez, a soma é a da campanha ativa.

O campo novo é opcional e vazio significa o comportamento de hoje — nenhuma
campanha existente muda sozinha. Para usar, a janela é escolhida no formulário da
campanha, no passo do ritmo (marcar "Rodar só em horário próprio" e escolher os
dias e as horas cheias de início e fim). A janela vale do início da campanha em
diante: ela não é editável numa campanha já iniciada, então quem quer aplicá-la a
uma campanha existente pausa, cria a nova com a janela e retoma o trabalho por
ela. A saída 2 da issue (várias campanhas no mesmo número ao mesmo tempo) NÃO
entra aqui: continua valendo uma campanha em andamento por número.
