---
impacto: nada_mudou
secao: corrigido
titulo: "As telas de configuração deixam de mostrar o erro cru do banco"
---

Quando o banco recusava uma gravação nas credenciais do Google e da Meta, na configuração do funil, no perfil, na troca de idioma ou na marca da instalação, a tela mostrava o texto do Postgres, com nome de tabela e de regra (por exemplo `violates check constraint "platform_branding_accent_hex"`). Agora ela mostra uma frase que diz o que aconteceu e o que fazer: a cor precisa ser um hexadecimal de seis dígitos, a conta não tem permissão, a sessão expirou, a gravação demorou e nada foi salvo. Erro que o sistema não reconhece vira "Não foi possível salvar. Tente de novo.". Na tela de marca, o aviso continua o genérico de antes, e a frase aparece no campo de detalhe técnico, onde antes ficava o texto do banco. O texto original do banco passa a ir para o log do servidor, para quem administra a VPS diagnosticar. Nada muda na configuração da VPS.

Crédito: @webtecnica (#3752, #3747).
