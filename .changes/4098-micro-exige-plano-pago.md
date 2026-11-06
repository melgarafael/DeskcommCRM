---
impacto: nada_mudou
secao: alterado
titulo: Os runbooks de Supabase dizem que o Micro exige plano pago
---

Os dois runbooks de Supabase mandavam subir o compute para o **Micro (1 GB)** quando a Nano do plano grátis não segurava o schema, sem dizer que esse compute só existe nos planos pagos. Quem seguia a orientação travava na decisão: precisa assinar o Pro **e** pagar o Micro por hora?

Agora as duas seções dizem que o Micro exige plano pago, que assinar não troca o compute (o projeto que veio do grátis pode seguir no Nano, cobrado como Micro, até a troca, e a troca causa uma queda) e qual é a ordem de grandeza: plano e crédito de US$ 10/mês são da organização, o que dá cerca de US$ 25/mês com um projeto no Micro e US$ 35/mês com dois. O valor aparece marcado como exemplo lido na doc oficial em 05/11/2026, com link para a página de compute do Supabase: preço muda, e quem ler depois precisa saber onde conferir.

Nada muda no produto: só a documentação.
