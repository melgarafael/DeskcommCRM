---
impacto: nada_mudou
secao: corrigido
titulo: O agente espera a foto ficar legível quando o cliente manda a foto e depois escreve
---

Quando o cliente mandava uma foto (um comprovante, por exemplo) e logo depois escrevia a pergunta em outra mensagem, o turno do agente saía pela mensagem de texto sem esperar a leitura da foto, e o agente pedia ao cliente que descrevesse uma imagem que o sistema terminava de ler segundos depois. Agora a espera olha a conversa inteira: se há mídia recebida ainda sendo lida, o turno aguarda até o mesmo teto de antes, contado a partir da hora em que a mídia chegou. Mídia que o sistema não vai ler (vídeo com leitura desligada, arquivo que não chegou ao storage) não segura a resposta.

Contribuição de @deskcommopp4s-cmd (#1594).
