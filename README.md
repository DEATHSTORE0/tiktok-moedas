# Coin Store independente — starter full-stack

Aplicação Node.js + Express + SQLite com frontend responsivo, contas, sessão, histórico de pedidos e indicações. O visual usa branco/cinza, moedas douradas e botões `#FE2C55`.

> **Aviso de marca:** este projeto é um serviço independente e não oficial. Não é afiliado, endossado ou operado pelo TikTok. Não use marcas, logos ou alegações que sugiram associação oficial. Confirme que a venda/entrega de qualquer crédito virtual é permitida pelo fornecedor e pelas plataformas envolvidas antes de aceitar pagamentos.

## Estado da integração de pagamentos

Os quatro links de checkout fornecidos foram incluídos no servidor. O servidor grava um pedido `pending` antes de abrir o checkout. O endpoint `/webhooks/cakto` valida a assinatura HMAC-SHA256 oficial usando `X-Cakto-Timestamp`, `X-Cakto-Signature`, o corpo bruto da requisição e o segredo gerado no painel. O servidor também confere o campo `secret` do corpo, associa o pedido pelo `callback` opaco acrescentado ao checkout, valida status/valor/moeda e usa idempotência para evitar crédito duplicado. **Ainda é necessário configurar o segredo no servidor e cadastrar/testar a URL pública no painel Cakto antes de vender.** Sem `CAKTO_WEBHOOK_SECRET`, o endpoint retorna 503 e não credita moedas.

Não considere uma volta do navegador como prova de pagamento. Para terminar a integração, use somente a documentação oficial atual da Cakto e configure no servidor:
- URL de webhook indicada pelo painel/documentação oficial;
- mecanismo oficial de autenticidade/assinatura e segredo emitido pela Cakto, se aplicável;
- campos/eventos oficiais para identificar pedido, status, valor e reembolsos;
- idempotência para impedir crédito duplicado;
- validação de correspondência entre pedido interno, produto e valor esperado;
- processamento de cancelamento/reembolso e reconciliação de pedidos.
Nunca cole segredos no frontend ou no GitHub.

## Pacotes cadastrados

- 700 moedas grátis — R$ 0,00
- 350 moedas — R$ 7,49 — `https://pay.cakto.com.br/3fzmsu2_1254497`
- 820 moedas — R$ 15,50 — `https://pay.cakto.com.br/egpnptr_1254529`
- 1.359 moedas — R$ 32,01 — `https://pay.cakto.com.br/dujmnbh_1254544`
- 2.707 moedas — R$ 75,00 — `https://pay.cakto.com.br/846tcw8_1254552`

## Executar localmente

Requer Node.js 20+.

```bash
cp .env.example .env
```

Edite `.env` e defina `SESSION_SECRET` com um valor aleatório de pelo menos 32 caracteres. Para gerar um valor localmente:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Instale e execute:

```bash
npm install
npm test
npm start
```

Abra `http://localhost:3000`.

## Configurar e-mail de recuperação

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` e `BASE_URL` em variáveis de ambiente no servidor de hospedagem. Sem SMTP, o envio de e-mail fica desabilitado; em desenvolvimento, o link de redefinição é mostrado apenas no log do servidor. Links expiram em 30 minutos e são armazenados no banco como hash.

## Banco de dados

SQLite persiste em `data/store.sqlite` e sessões em `data/sessions.sqlite`. Para um deploy com várias instâncias ou disco efêmero, substitua SQLite por banco gerenciado persistente e um store de sessão compatível. Faça backups e proteja os arquivos do banco.

## Publicar no Replit

1. Crie um projeto Node.js e envie os arquivos desta pasta.
2. Defina os segredos no painel **Secrets/Environment Variables** do Replit; não suba `.env`.
3. Configure `NODE_ENV=production`, `BASE_URL` com a URL pública e `SESSION_SECRET` forte.
4. Confirme que o deploy mantém disco persistente para `data/`. Se não, use banco persistente gerenciado.
5. Configure SMTP e teste recuperação de senha em um ambiente controlado.
6. Antes de abrir vendas, conclua e teste o webhook oficial da Cakto. Até lá, mantenha a loja em modo de teste/indisponível para venda real.

## Segurança e limitações atuais

Implementado:
- Hash de senha com bcrypt (12 rounds), sessão `HttpOnly`, `SameSite=Lax`, `Secure` em produção e rotação de sessão no login.
- Rate limit em autenticação, Helmet, validação de entrada e consultas parametrizadas.
- Pedidos criados no servidor com valores e quantidades fixos no servidor.
- Histórico de pedidos e logs de auditoria.
- Pedido fica pendente; não existe endpoint público para marcar pagamento como aprovado.
- Resgate grátis é registrado como solicitação pendente e não credita saldo automaticamente.
- Indicações rastreiam cadastros; as recompensas não são creditadas até existir confirmação de pagamento autenticada.

Ainda pendente:
- Configurar `CAKTO_WEBHOOK_SECRET` como segredo do servidor, criar webhook na Cakto apontando para `https://SEU-DOMINIO/webhooks/cakto` e habilitar eventos `purchase_approved`, `refund` e `chargeback`.
- Testar com eventos de teste e confirmar que o payload real contém o `callback` correspondente; o evento de teste pode não estar ligado a um pedido real e não deve creditar saldo.
- Revisar a política de reversão de recompensas por indicação quando uma compra é reembolsada; as recompensas e a antifraude precisam de testes de integração antes de produção.
- Créditos no saldo após pagamento confirmado estão implementados no webhook; a entrega real das moedas ao destino do cliente ainda depende do mecanismo de entrega do seu serviço.
- Controles antifraude fortes para múltiplas contas (rate limits adicionais, análise de risco e revisão manual); o sistema não consegue provar que contas pertencem a pessoas diferentes só com e-mail.
- Verificação de e-mail, CSRF token/origin checks reforçados e política de privacidade/termos adequados à operação.
- Testes de integração completos com provedor de e-mail, sessões e pagamentos reais em sandbox.

## Testes

`npm test` valida os pacotes e os links de checkout. Isso é apenas um teste smoke, não prova que login, e-mail, Cakto ou deploy foram testados de ponta a ponta. Teste tudo em ambiente local antes de usar.
