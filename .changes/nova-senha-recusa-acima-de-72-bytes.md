---
impacto: nada_mudou
secao: corrigido
titulo: A tela de nova senha avisa quando a senha passa do limite de tamanho
---

Ao definir uma nova senha, uma senha acima de 72 bytes era aceita pelo formulário e recusada depois pelo serviço de autenticação, e a tela mostrava só um erro genérico. Agora o formulário recusa na hora e explica o limite. O limite é contado em bytes, então acento e emoji pesam mais que uma letra simples. Criado por @webtecnica, a partir do #4313.
