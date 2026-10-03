---
impacto: nada_mudou
secao: corrigido
titulo: O link de redefinir senha, de convite e de confirmar cadastro funciona para quem usa Hotmail, Outlook e e-mail corporativo
---

Quem recebia o e-mail num Hotmail, Outlook ou numa caixa corporativa clicava no link e caía em "Link inválido ou expirado", mesmo pedindo um link novo. O motivo: esses provedores abrem cada link sozinhos, segundos depois da entrega, para conferir se é seguro, e o CRM gastava o token de uso único nessa primeira visita. Agora o link leva a uma tela "Confirmar acesso" com o botão Continuar, e o token só é usado quando a pessoa aperta o botão. Verificador automático abre o link, mas não aperta o botão. Nada muda na configuração da instalação.

Contribuição de @fabianmartinelli-fm.
