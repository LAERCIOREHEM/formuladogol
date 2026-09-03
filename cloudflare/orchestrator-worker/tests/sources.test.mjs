import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepositoryJson, fetchSiteBundle, repositoryFallbacks } from '../src/sources.js';

function env() {
  return {
    SITE_BASE: 'https://formuladogol.com.br',
    GITHUB_REPOSITORY: 'LAERCIOREHEM/formuladogol',
    GITHUB_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('site source wins and GitHub is not touched when public artifact exists', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse({ origem: 'site' });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const bundle = await fetchSiteBundle(env(), ['dados-br/agenda-clubes-br.json']);
  assert.equal(bundle['dados-br/agenda-clubes-br.json'].origin, 'site');
  assert.deepEqual(bundle['dados-br/agenda-clubes-br.json'].data, { origem: 'site' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/formuladogol\.com\.br\//);
});

test('404 on Pages transparently falls back to authenticated GitHub repository content', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://formuladogol.com.br/')) return jsonResponse({ error: 'missing' }, 404);
    if (String(url).startsWith('https://api.github.com/repos/LAERCIOREHEM/formuladogol/contents/')) {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      return jsonResponse({ interno: true });
    }
    throw new Error(`URL inesperada ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const path = 'dados-br/config-analises.json';
  const bundle = await fetchSiteBundle(env(), [path]);
  assert.equal(bundle[path].origin, 'github');
  assert.equal(bundle[path].error, '');
  assert.deepEqual(bundle[path].data, { interno: true });
  assert.equal(repositoryFallbacks(bundle).length, 1);
  assert.match(repositoryFallbacks(bundle)[0], /GitHub fallback/);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/contents\/dados-br\/config-analises\.json\?ref=main$/);
});

test('GitHub fallback fails closed when token is unavailable', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: 'missing' }, 404);
  t.after(() => { globalThis.fetch = originalFetch; });

  const badEnv = { ...env(), GITHUB_TOKEN: '' };
  const path = 'dados-br/config-analises.json';
  const bundle = await fetchSiteBundle(badEnv, [path]);
  assert.equal(bundle[path].origin, 'none');
  assert.match(bundle[path].error, /GITHUB_TOKEN ausente/);
});

test('repository path uses raw GitHub media type and configured branch', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /contents\/dados-br\/competicoes-af-previsao\/copa-do-brasil\.json\?ref=main$/);
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
    return jsonResponse({ ok: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(await fetchRepositoryJson(env(), 'dados-br/competicoes-af-previsao/copa-do-brasil.json'), { ok: true });
});
