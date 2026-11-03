---
impacto: exige_acao
secao: corrigido
titulo: Salvar outra configuração da instalação não reabre mais o cadastro fechado por SIGNUP_MODE
---

Numa instalação que fechou o cadastro só pelo `.env` (`SIGNUP_MODE=so_convite`), sem nunca abrir a tela **Cadastro** do painel da instalação, salvar o comportamento da instalação ou a lista de destinos internos reabria o cadastro. A tela de criar conta voltava a aparecer para qualquer pessoa. Isso acontecia porque essas telas gravam na mesma linha de configuração que guarda o modo de cadastro, e a linha nascia com o cadastro aberto, que vale mais que o `.env`.

Agora, quando essas telas criam a linha, ela nasce com o modo de cadastro que estava em vigor. Instalação sem `SIGNUP_MODE` continua aberta, como antes.

## Requer atenção

A atualização não corrige uma instalação que já foi reaberta assim. Se você usa `SIGNUP_MODE=so_convite` e alguma vez salvou o comportamento ou os destinos internos, abra **Cadastro** no painel da instalação, confira a chave e ligue **Cadastro apenas por convite** de novo.
