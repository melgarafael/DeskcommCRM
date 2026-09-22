---
impacto: capacidade_nova
secao: adicionado
titulo: Entrar com o Google, sem senha, nas telas de entrar e de criar conta
---

Quem usa Google Workspace já não precisa criar mais uma senha para começar:
as telas de entrar e de criar conta ganharam o botão **Entrar com Google**. Ele
funciona nos dois sentidos — entra quem já tem conta e cria a conta quem não
tem —, sem tela intermediária e sem pedir confirmação por e-mail.

Alguns cuidados que valem para quem opera:

- Quem chega por um **convite** continua entrando na empresa que convidou, pelo
  Google também. Sem isso, a pessoa convidada ganharia uma empresa própria e um
  assistente de boas-vindas que não é dela.
- Numa instalação de **cadastro apenas por convite**, o Google continua barrado
  para quem não tem convite — e continua liberado para quem já usa o sistema.
- Quem tem **verificação em duas etapas** cadastrada continua sendo obrigado a
  confirmar o código. Seria fácil deixar a porta mais nova mais fraca que a
  antiga.
- Para ligar o botão de verdade, o provedor Google precisa estar habilitado no
  projeto Supabase da instalação (Authentication → Providers). Com ele
  desligado, a tela diz exatamente isso, em vez de um erro genérico.
