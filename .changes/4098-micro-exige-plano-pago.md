---
impacto: nada_mudou
secao: alterado
titulo: Os runbooks de Supabase dizem que o Micro exige plano pago
---

Os dois runbooks de Supabase mandavam subir o compute para o **Micro (1 GB)**
quando a Nano do plano grátis não segurava o schema, sem dizer que esse compute
não existe no plano grátis — no pago não se cria Nano, só Micro ou maior. Quem
seguia a orientação travava na decisão: precisa assinar o Pro **e** pagar o Micro
por hora?

Agora as duas seções dizem, na mesma frase, que o Micro exige plano pago e qual é
a ordem de grandeza: o plano pago inclui US$ 10/mês em créditos de compute, que
costumam cobrir um projeto inteiro no Micro, e o que sobra é o preço do plano. O
valor aparece marcado como exemplo lido na doc oficial em 05/11/2026, com link
para a página de compute do Supabase — preço muda, e quem ler depois precisa
saber onde conferir.

Nada muda no produto: só a documentação.
