---
impacto: capacidade_nova
secao: adicionado
titulo: A instalação pode aceitar só quem foi convidado
---

Em **Admin › Cadastro** há um interruptor novo: **cadastro apenas por convite**. Ligado, `/signup` deixa de aceitar quem chega sem convite — e quem chega com um convite válido entra igual.

**Nada muda para quem não ligar.** O padrão é o comportamento de sempre: qualquer pessoa cria conta e abre a própria empresa. Instalações que já existem não precisam fazer nada.

**Por que isto é do produto, e não do proxy.** Fechar `/signup` no nginx era a única saída até aqui, e ela erra por construção: proxy não sabe o que é um convite. Medido numa instalação real em 2026-09-10 — a regra que bloqueava `/signup` bloqueou junto o `/signup?invite=…`, ou seja, exatamente quem deveria passar, e o convidado ficou sem conseguir entrar.

**A recusa tem tela.** Quem abre o cadastro sem convite numa instalação fechada vê uma página com a marca e o idioma da instalação, explicando que o acesso é por convite e oferecendo o login — não um `403 Forbidden` cru do servidor.

**Fecha nas quatro portas, não só na tela.** A tela é adulterável e a server action é chamável direto, então a recusa acontece também em `signUp()`, em `/auth/confirm` (que é quem provisiona a organização, e pega inclusive conta nascida fora da tela) e na recuperação de organização. Uma porta só seria outro capacho.

**Se o banco parar de responder, a instalação fechada continua fechada.** A leitura guarda o último valor conhecido em vez de cair no padrão — senão um soluço do banco reabriria o cadastro sem ninguém ver. E instalação que ainda não aplicou esta versão do schema continua aberta, como sempre esteve.
