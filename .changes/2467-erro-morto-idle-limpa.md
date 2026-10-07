---
impacto: nada_mudou
secao: corrigido
titulo: Erro antigo de sincronização Google some sozinho quando não há mais nada para enviar
---

Um compromisso cuja sincronização com o Google falhou um dia (por exemplo, com a conta desconectada) continuava mostrando o erro para sempre, mesmo depois de a conexão voltar e não haver mais nada para enviar — e o botão "Tentar sincronizar novamente" não resolvia, porque a rodada seguinte concluía que estava tudo igual e mantinha o texto do erro.

Agora, quando a rodada confirma que está tudo igual, ela apaga o erro guardado. Nada muda para quem nunca viu esse erro.
