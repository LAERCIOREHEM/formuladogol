import assert from 'node:assert/strict';
import { fetchEspnScoreboard, fetchEspnSummary, probeEspnSources, unwrapScoreboard, unwrapSummary } from '../src/espn-source.js';

const event = {
  id: '401909112',
  status: { type: { state: 'pre', completed: false } },
  competitions: [{ competitors: [] }]
};

assert.equal(unwrapScoreboard({ events: [event] }).events.length, 1);
assert.equal(unwrapScoreboard({ content: { events: [event] } }).events[0].id, event.id);
assert.ok(unwrapSummary({ gamepackageJSON: { plays: [{ id: 'p1' }] } }).plays);

{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/core/soccer/scoreboard')) return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    if (href.includes('/core/bra.copa_do_brazil/scoreboard')) return Response.json({ content: { events: [event] } });
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnScoreboard('bra.copa_do_brazil', '20260901', fakeFetch);
  assert.equal(result.source, 'espn_cdn_league');
  assert.equal(result.data.events[0].id, event.id);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[1].ok, true);
  assert.equal(calls.length, 2);
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('cdn.espn.com')) return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [event] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboard('bra.1', '20260901', fakeFetch);
  assert.equal(result.source, 'espn_site_api');
  assert.equal(result.data.events.length, 1);
  assert.equal(result.attempts.length, 3);
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/soccer/game')) return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    if (href.includes('/core/bra.copa_do_brazil/game')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal' }] } });
    }
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnSummary('bra.copa_do_brazil', event.id, fakeFetch);
  assert.equal(result.source, 'espn_cdn_league_game');
  assert.equal(result.data.plays[0].id, 'g1');
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ events: [] });
    throw new Error(`não deveria usar fallback no probe: ${href}`);
  };
  const probe = await probeEspnSources(fakeFetch, '20260901');
  assert.equal(probe.ok, true);
  assert.equal(probe.sourceLayerVersion, '6-R1');
  assert.equal(Object.keys(probe.leagues).length, 4);
  assert.deepEqual(probe.failed, []);
  assert.ok(Object.values(probe.leagues).every((row) => row.source === 'espn_cdn_soccer'));
}

console.log('espn-source: PASS');
