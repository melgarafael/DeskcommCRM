---
impacto: nada_mudou
secao: corrigido
titulo: Comentários e mensagens do kit passam a dizer o que o Compose mede, sem mudança na atualização
---

Quem opera e quem mexe no kit lia comentários e mensagens que descreviam o
`docker compose up -d` de um jeito que a medição contraria: com `image:` e
`build:` lado a lado no mesmo serviço, o Compose constrói em QUALQUER falha de
pull — tag inexistente, registro fora por DNS, arquitetura diferente da das
imagens publicadas —, não só na última. Os comentários do `update.sh`, do
`install.sh` e do `_common.sh` e a mensagem de pull que falhou passam a dizer
o que a máquina faz: worker, scheduler e agente de voz continuam com imagem
publicada e construção local lado a lado (é o escape barato deles), e o `app`
continua SEM `build:` no compose de produção, de propósito — é a falta da
imagem dele que faz o `up -d` falhar e entrega a decisão ao portão que recusa
construir quando o registro não responde. Os testes de packaging passam a
prender os dois lados dessa régua. Nada muda na instalação que já funciona:
mesma imagem puxada, mesma recuperação, mesma versão no final.
