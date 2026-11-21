---
impacto: nada_mudou
secao: corrigido
titulo: Cadastro e convite de equipe recusam senha acima de 72 bytes
---

O cadastro e o convite de equipe passam a recusar senha com mais de 72 bytes, com a mesma regra que a troca de senha já aplicava — e com a mensagem dizendo qual é o limite. A conta é por bytes, não por caracteres: senha com acento ou emoji ocupa mais de um byte por caractere e chega ao limite antes do que a contagem de caracteres sugere.
