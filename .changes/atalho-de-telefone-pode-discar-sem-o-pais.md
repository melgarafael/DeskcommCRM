---
impacto: capacidade_nova
secao: alterado
titulo: Atalho de telefone do card pode discar sem o código do país
---

O atalho `tel:{{telefone}}` do card do negócio montava sempre o número como o
contato está gravado, com o `+55`. Em central telefônica que disca DDD + número
— o PABX em nuvem com softphone no Windows, que é o caso que pediu o atalho —
isso vira chamada internacional, e o vendedor voltava a copiar e colar o
telefone, que é justamente o que o atalho veio evitar.

Cada atalho `tel:` ganhou a escolha da forma da discagem. **Com o código do país**
é o padrão e o comportamento de todo atalho já cadastrado. **Sem o código do país**
manda DDD + número para o softphone, tirando o `55` só quando o número tem o
tamanho de um brasileiro com código de país e um DDD válido depois dele. Um
número que começa com `55` por ser DDD (Santa Maria) ou um telefone de outro país
não é cortado. A opção aparece no cadastro do funil apenas no atalho `tel:` — num
link `https://` o telefone é dado para o outro sistema, não alvo de discagem.
