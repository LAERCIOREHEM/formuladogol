# PASSO A PASSO — BOLÃO COPA 2026 (do zero ao ar)

Guia mastigado. Cada passo diz **ONDE** (qual programa/site) e **O QUE** fazer.

## O que mudou nesta versão (correções)
- ✅ **Anexo C já vem PRONTO** (`dados/terceiros_map.json`, 495 combinações
  conferidas). Você **não precisa** rodar script para isso.
- ✅ O script `extrair_anexo_c.py` foi consertado (o erro **HTTP 403** acontecia
  porque a Wikipedia recusa o "User-Agent" padrão do Python). Agora ele só serve
  para **reconferir**, se você quiser.
- ✅ **Bandeiras** dos países na interface (imagens, não emoji — emoji de bandeira
  não aparece no Windows).
- ✅ **Área do organizador** (`admin.html`) para criar participantes e PINs.
- ✅ Corrigida a estrutura oficial da 2ª fase (as 16 vagas estavam fora de ordem).

---

## A ideia geral (leia primeiro)

São **3 lugares**, nesta ordem:

```
  FASE 1                 FASE 2                  FASE 3
  Seu computador   →     Supabase (site)   →     GitHub (site do Brasileirão)
  (Terminal/navegador)   banco de dados          publicar a aba da Copa
  testar                 palpites e ranking       deixar no ar
```

- **Fase 1** roda **só no seu PC**. Nada vai pro ar. É pra ver funcionando.
- **Fase 2** cria o "cérebro" online onde os palpites de todos ficam guardados.
- **Fase 3** copia a pasta `copa2026/` pra dentro do site do Brasileirão.

O módulo é **isolado**: não mexe em nada do bolão do Brasileirão.

---

# FASE 1 — TESTAR NO SEU COMPUTADOR

## Passo 1 — Abrir o Terminal
**ONDE:** o **Terminal** — o mesmo programa preto onde você roda `git` e `npm`.
- Windows: menu Iniciar → digite "PowerShell" → Enter.
- Mac: `Cmd + Espaço` → "Terminal" → Enter.

## Passo 2 — Entrar na pasta do módulo
Descompacte o zip. No seu caso a pasta é:
```
C:\Users\laerc\documents\site_apostas\copa2026
```
No Terminal:
```bash
cd C:\Users\laerc\documents\site_apostas\copa2026
```

## Passo 3 — Ligar o site no seu PC
**ONDE:** Terminal, dentro da pasta `copa2026`:
```bash
python -m http.server 8000
```
> No Windows, se `python` não funcionar, use `py -m http.server 8000`.

Vai aparecer "Serving HTTP on ... port 8000". **Deixe esse Terminal aberto.**

**ONDE:** no navegador, acesse:
```
http://localhost:8000
```
Você verá a tela de login. Como ainda não há lista de participantes, está em
**modo teste**: entre com um nome e um PIN de 6 dígitos qualquer, preencha uns
grupos e veja a classificação (com bandeiras) mudar ao vivo. Avance pela 2ª fase
até a final — o chaveamento monta sozinho até o campeão.

> Para **parar** o servidor: no Terminal, `Ctrl + C`.

✅ **Fim da Fase 1:** o bolão funciona no seu PC.

> **Sobre o script do Anexo C:** você **não precisa** rodá-lo — o
> `dados/terceiros_map.json` já vem com as 495 combinações conferidas. Só se
> quiser reconferir: `cd scripts` → `pip install requests pandas lxml` →
> `python extrair_anexo_c.py`. (Agora sem o erro 403.)

---

# FASE 1.5 — CRIAR OS PARTICIPANTES (área do organizador)

Você (organizador) cria a lista de nomes e o sistema gera os PINs.

## Passo 4 — Abrir o admin
**ONDE:** no navegador, com o servidor ligado:
```
http://localhost:8000/admin.html
```
(ou clique em "Área do organizador" na tela de login).

## Passo 5 — Gerar os PINs
1. Digite **um nome por linha** na caixa.
2. Clique **"Gerar PINs"** — cada pessoa recebe um PIN de 6 dígitos.
3. Na lista, o botão **WhatsApp** copia uma mensagem pronta (nome + PIN + link)
   para você colar na conversa da pessoa. **Resetar PIN** troca o número se
   alguém perder. A coluna **Status** mostra quem já enviou o palpite.

> No modo teste a lista fica salva só neste navegador. Em produção ela vai para
> o Supabase (Fase 2), com o PIN guardado criptografado.

✅ **Fim da Fase 1.5:** participantes criados; cada um entra com nome + PIN.

---

# FASE 2 — BANCO ONLINE (SUPABASE)

Sem isto, cada pessoa só vê o palpite no próprio aparelho. Com o Supabase você
tem **ranking** e **transparência** (ver o palpite dos outros depois da trava).

## Passo 6 — Criar o projeto
**ONDE:** navegador → **supabase.com** → "Start your project" → entre com o
**GitHub** → **"New project"**:
- Name: bolao-copa · Database Password: crie e **guarde** · Region: South America.
- "Create new project" e espere ~2 min.

## Passo 7 — Criar as tabelas
**ONDE:** menu esquerdo → **"SQL Editor"** → "New query" → cole e clique **Run**:
```sql
create extension if not exists pgcrypto;

create table participantes (
  id uuid primary key default gen_random_uuid(),
  nome text unique not null,
  pin_hash text not null
);
create table palpites (
  participante_id uuid references participantes(id) primary key,
  payload jsonb not null, derivado jsonb, enviado_em timestamptz
);
create table config (chave text primary key, valor jsonb);
insert into config values ('trava','"2026-06-10T23:59:59-03:00"'), ('revelado','false');
```

## Passo 8 — Cadastrar os participantes
**ONDE:** mesmo SQL Editor. Use os nomes e PINs que o admin gerou:
```sql
insert into participantes (nome, pin_hash) values
  ('Carlos',  crypt('481920', gen_salt('bf'))),
  ('Mariana', crypt('739104', gen_salt('bf')));
```
Mande cada PIN por WhatsApp (o banco guarda só o hash — nunca o PIN em texto).

## Passo 9 — Pegar as chaves
**ONDE:** "Project Settings" (engrenagem) → "API" → copie **Project URL** e a
**anon public** key.

**A ligação do `app.js`/`admin.js` com o Supabase eu faço pra você.** Quando
chegar aqui, me mande a Project URL que eu te devolvo os arquivos já conectados
(login, salvar, ranking e transparência pós-trava). A `anon key` pode ficar no
front com segurança, porque as regras (RLS) protegem os dados.

✅ **Fim da Fase 2:** banco criado e participantes cadastrados.

---

# FASE 3 — SUBIR NO SITE DO BRASILEIRÃO (GITHUB)

## Passo 10 — Copiar a pasta
**ONDE:** no seu PC, copie a pasta `copa2026/` para **dentro do repositório do
site** (onde está o `index.html` do Brasileirão).

## Passo 11 — Acender a aba no site principal
**ONDE:** abra o `index.html` do Brasileirão e adicione:
```html
<a href="copa2026/" class="aba-copa">🏆 Bolão Copa 2026</a>
```
> Quer que ele apareça só de 05/06 a 20/07? Me avise que eu passo o trechinho de
> JS que mostra/esconde, sem tocar na lógica do Brasileirão.

## Passo 12 — Publicar
**ONDE:** Terminal, na pasta do repositório:
```bash
git add copa2026
git commit -m "Adiciona modulo Bolao Copa 2026"
git push
```
Em ~1 min o GitHub Pages publica em `seu-site/copa2026/`.

## Passo 13 — Robô de resultados (opcional, durante a Copa)
**ONDE:** ge.globo.com → tabela da Copa → tecle **F12** → aba **Network** →
filtre `api.globoesporte` → copie o **uuid** e os **slugs** das chamadas
`/tabela/{uuid}/fase/{slug}/...`. Cole em `scripts/atualizar_copa.py`. Depois
crie `.github/workflows/atualizar-copa.yml` (peça que eu monto o arquivo).

✅ **Fim:** bolão no ar, dentro do site do Brasileirão.

---

# RESUMO ULTRA-CURTO

| Quero... | Vou em... | E faço... |
|---|---|---|
| Testar no meu PC | **Terminal** | `python -m http.server 8000` → abrir localhost:8000 |
| Criar nomes/PINs | **navegador** | abrir `localhost:8000/admin.html` → "Gerar PINs" |
| (Re)conferir Anexo C | **Terminal** (scripts) | `python extrair_anexo_c.py` (opcional) |
| Guardar palpites/ranking | **supabase.com** | criar projeto, rodar os SQLs |
| Publicar no site | **GitHub** | copiar `copa2026/`, `git push` |

## Ordem certa, se o tempo apertar
1. Fase 1 (testar) + Fase 1.5 (criar PINs) — **essencial**.
2. Fase 2 (Supabase) — pra ter ranking e transparência reais.
3. Fase 3 (publicar) — quando estiver redondo.

Chegou no Passo 9? Me chame com a Project URL que eu conecto o Supabase.
