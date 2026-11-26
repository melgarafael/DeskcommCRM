---
impacto: capacidade_nova
secao: alterado
titulo: Login passa a ter bloqueio crescente por conta, contado no dia
---

O login já barrava 5 senhas erradas na mesma conta a cada 5 minutos. O problema é que essa janela zerava: 5 erros a cada 5 minutos davam até 1.440 tentativas por dia contra a mesma conta, todo dia, sem deixar rastro que distinguisse isso de alguém esquecido da senha.

Agora há uma segunda conta, a do dia (vira à meia-noite UTC), que não zera a cada 5 minutos e cujo castigo cresce com o número de falhas na mesma conta:

- 5 falhas no dia: 5 minutos de bloqueio (o mesmo castigo da janela curta, agora lembrado);
- 10 falhas no dia: 30 minutos, e cada falha nova a partir daí renova os 30 minutos.

Na conta mais rápida possível, quem tenta adivinhar a senha consegue no máximo 57 tentativas por dia contra a mesma conta, em vez de cerca de 1.440. O castigo mais longo é de 30 minutos: ninguém consegue trancar o dono fora do próprio CRM só por saber o e-mail dele.

A janela curta continua valendo exatamente como estava, e o teto de 60 tentativas por IP também. Enquanto o castigo dura, nem a senha certa entra; redefinir a senha pelo "esqueci minha senha" destrava na hora.

A mesma régua vale nas três portas que conferem credencial de conta: entrar com senha, trocar a senha do primeiro acesso e aceitar convite. A resposta ao navegador é a mesma de antes ("muitas tentativas"), e a sequência de respostas é idêntica para um e-mail que não existe: o bloqueio não serve para descobrir quem tem conta.

Na auditoria, cada degrau grava um evento quando nasce (`auth.login_bloqueio_5min`, `auth.login_bloqueio_30min`), e o desbloqueio pela redefinição de senha também (`auth.login_bloqueio_removido`). A tentativa barrada continua no registro de sempre (`auth.login_rate_limited`), com o degrau anotado ao lado.

Quem atualiza não precisa fazer nada. O contador é o mesmo do resto do produto: Upstash quando está configurado, memória do processo quando não está. Numa instalação com mais de uma instância e sem Upstash, o número de falhas conta por instância.

Ainda não há aviso por e-mail ao dono da conta nem destravamento pelo administrador; isso segue na issue #4743.

Contribuição de @webtecnica, a partir da issue #4743.
