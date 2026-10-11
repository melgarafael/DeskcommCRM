---
impacto: nada_mudou
secao: alterado
titulo: Falha ao assinar o link de uma mídia vai para o log estruturado
---

Quando o sistema não conseguia gerar o link temporário de uma foto, áudio ou vídeo do WhatsApp guardado no armazenamento, o erro saía como uma linha solta no log do contêiner, sem dizer de qual mensagem era. Agora ele sai no mesmo formato estruturado dos demais erros, com o identificador da mensagem, o que facilita achar o caso no `docker compose logs`.

Você não precisa fazer nada. O comportamento da tela não muda.

Contribuição de @mrmateussiilva, a partir do #1921.
