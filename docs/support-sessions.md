# Acompanhamento administrativo

Em Administração → Organizações → detalhe → Acompanhar organização, a pessoa
escolhe edição ou somente leitura. O aplicativo abre os dados da organização
escolhida e mantém a identidade real do administrador. O banner oferece a saída.
Organizações ainda não configuradas também abrem nesse shell; acompanhamento
não conclui onboarding e o acesso ao wizard retorna ao aplicativo com o banner.
O prazo máximo é uma hora; expiração ou revogação bloqueiam a continuação até a
saída explícita, que restaura a organização anterior e reinicia os dados da tela.

O acesso é temporário e vinculado à sessão Supabase que o iniciou. Não cria
membership, conta de cliente nem elegibilidade de atendente. Outra sessão da
mesma pessoa conserva seu contexto. Os direitos preexistentes da plataforma em
outras organizações continuam existindo; esta função não confina todo o JWT.

Somente leitura prevalece sobre uma membership física admin no alvo. Cercas
restritivas de DML e guardas de RPC/handlers/actions impedem efeitos no alvo;
o observador não paralisa workers ou outros atendentes. A interface segue os
módulos já permitidos a viewer, sem dar acesso de admin às páginas de configuração.
Abrir inbox não marca mensagem lida nem envia comandos operacionais.

`platform_support_sessions` é a autoridade. O cookie assinado referencia a
sessão, mas não concede acesso sozinho. `fn_support_context` combina ator,
claim `session_id`, sessão Auth existente, prazo, organização, plataforma atual
e MFA. O modo efetivo é o mais restritivo entre o início e o scope atual.
`auth_session_id` é uma referência histórica deliberadamente sem FK: CASCADE
apagaria o marcador de revogação; RESTRICT impediria Auth de encerrar sessões.
O início valida a referência sob lock e cada uso reconfirma sua existência.
Nenhuma tabela do schema Auth é criada pela migration do produto.

A auditoria prometida é a das operações pela superfície do aplicativo, com
ator real e `support_session_id` no metadata. Não existe editor SQL novo nem
promessa de trilha de todo DML bruto. O enrichment confere o ator da request ou ator/sessão do state OAuth validado;
cron sem usuário autenticado não ganha autoria do observador.

Callbacks OAuth recebem `state` assinado com ator/sessão, porque o JWT Strict
não acompanha o retorno cross-site. A escrita reconfirma a cerca de suporte
antes do efeito. Estados antigos sem sessão seguem o fluxo basal sem suporte
restrito; diante de ambiguidade readonly no alvo, pedem reiniciar a conexão.
No state Nuvemshop antigo nem ator existia, então a recusa conservadora alcança
o alvo inteiro durante suporte restrito. Estados novos de outra sessão são
independentes. Não se presume aprovação pelo tempo transcorrido.

Fontes: migration0220, `lib/impersonate/support.ts`, `lib/auth/server.ts`,
`tests/invariants/suporte-temporario.test.ts`, `tests/invariants/suporte-auditoria.test.ts` e
`tests/e2e/suporte-temporario.spec.ts`. A cerca de efeitos tem gate de inventário
em `tests/unit/suporte-cobertura-de-efeitos.test.ts`; a superfície de definers
é conferida no catálogo aplicado pelo gate existente de hardening.

Sistema vivo: entrada pelo detalhe da organização; saída para contexto/cache;
auditoria acessível na administração; prazo/revogação sempre têm próximo passo
visível (sair). Trata autoridade humana, sem decisão autônoma de IA ou follow-up.
A falha de autorização deixa registro/erro recuperável em vez de fallback mudo.
