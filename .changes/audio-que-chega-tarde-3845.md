---
impacto: nada_mudou
secao: corrigido
titulo: A espera pela transcrição do áudio também cobre o áudio que chega no instante em que a resposta é registrada
---

Complemento da correção do áudio que chega durante a resposta (#3836). A conferência que pergunta se a mídia ainda está virando texto passa a ler a hora de chegada no formato em que o banco a entrega; sem isso ela respondia "nada pendente", e nem a espera pelo áudio do meio da resposta nem a que segura o início da resposta chegavam a esperar. Junto vem o ajuste do registro de "até aqui eu li": ele cobre só o que a resposta leu com texto, então o áudio que chega no instante entre a última conferência e esse registro mantém a própria resposta, e a resposta desatualizada é descartada em vez de sair. Nenhuma configuração muda. Contribuição de @webtecnica (#3845).
