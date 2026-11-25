---
impacto: capacidade_nova
secao: adicionado
titulo: O kit ganha um comando para trocar o e-mail de login pelo terminal da VPS
---

O instalador cria o dono como `admin@<domínio>`, um endereço que quase nunca é uma caixa de verdade, e até aqui não havia como trocar esse login. Agora, na pasta do projeto:

```
bash hostgator-setup-kit/change-email.sh <e-mail atual> <e-mail novo>
```

A troca vale na hora, sem precisar de e-mail configurado na instalação, e a senha continua a mesma. O endereço antigo deixa de entrar. O `.env` e o `.runtime/admin-credentials` acompanham a troca quando guardavam o endereço antigo, para que uma reinstalação não recrie o `admin@`. Serve para qualquer login da instalação, como o `reset-password.sh`. Quem não rodar o comando não vê diferença.

Crédito: @webtecnica (issue #5073).
