---
impacto: nada_mudou
secao: corrigido
titulo: Áudio e foto que chegam no meio do turno voltam a ser esperados antes da resposta
---

Quando o cliente manda um áudio ou uma foto no meio do turno, o sistema deve esperar a transcrição antes de escrever a resposta. A espera existia, mas não funcionava: a consulta que pergunta se a mídia ainda está virando texto comparava a hora de chegada como se ela viesse do banco em texto, e o driver entrega a data já convertida. Resultado: ela respondia sempre "nada pendente" e o turno seguia sem esperar nada — o cliente recebia "não consegui ouvir seu áudio" segundos antes de a transcrição ficar pronta.

Agora a régua entende as duas formas da data. Junto vem o ajuste que faltava no registro de "até aqui eu li": ele passa a cobrir apenas o que o turno leu com texto, então o áudio que chega no instante entre a última checagem e o registro não é dado como lido sem ter conteúdo — ele mantém o próprio turno, e a resposta desatualizada é descartada em vez de sair. Nenhuma configuração muda. Contribuição de @webtecnica (#3845).
