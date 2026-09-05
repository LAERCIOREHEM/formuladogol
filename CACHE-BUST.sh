#!/usr/bin/env bash
# Executar na raiz do repositório formuladogol. Força os aparelhos a baixar o JS corrigido.
set -e
V=20260905-push-resiliencia-v1
sed -i "s|/js/br-push\.js?v=[^\"]*|/js/br-push.js?v=$V|g"       index.html alertas.html aovivo.html clubes.html pwa-teste.html
sed -i "s|/js/br-alertas\.js?v=[^\"]*|/js/br-alertas.js?v=$V|g" index.html alertas.html aovivo.html clubes.html
grep -n "br-push.js?v=\|br-alertas.js?v=" index.html alertas.html aovivo.html clubes.html pwa-teste.html
