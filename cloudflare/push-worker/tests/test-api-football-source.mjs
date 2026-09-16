import assert from 'node:assert/strict';
import { fetchApiFootballStatsFallback } from '../src/api-football-source.js';

function espnSummary() {
  return {
    header: {
      competitions: [{
        date: '2026-09-16T00:30:00Z',
        status: { type: { state: 'in', completed: false } },
        competitors: [
          { homeAway: 'home', team: { id: '123', displayName: 'São Paulo', abbreviation: 'SAO' } },
          { homeAway: 'away', team: { id: '456', displayName: 'Boca Juniors', abbreviation: 'CABJ' } }
        ]
      }]
    },
    boxscore: { teams: [] }
  };
}

function apiFixture() {
  return {
    fixture: { id: 999001, date: '2026-09-15T21:30:00-03:00', status: { short: '1H' } },
    teams: {
      home: { id: 10, name: 'Sao Paulo' },
      away: { id: 20, name: 'Boca Juniors' }
    }
  };
}

{
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, key: options?.headers?.['x-apisports-key'] || '' });
    if (href.includes('/fixtures?live=all')) {
      return Response.json({ errors: [], response: [apiFixture()] }, { headers: { 'x-ratelimit-requests-remaining': '999' } });
    }
    if (href.includes('/fixtures?ids=999001')) {
      return Response.json({
        errors: [],
        response: [{
          ...apiFixture(),
          statistics: [
            { team: { id: 10, name: 'Sao Paulo' }, statistics: [
              { type: 'Ball Possession', value: '57%' },
              { type: 'Total Shots', value: 8 },
              { type: 'Shots on Goal', value: 3 },
              { type: 'Blocked Shots', value: 2 },
              { type: 'Fouls', value: 9 },
              { type: 'Goalkeeper Saves', value: 1 },
              { type: 'Total passes', value: 221 },
              { type: 'Passes accurate', value: 191 },
              { type: 'Passes %', value: '86%' },
              { type: 'Corner Kicks', value: 4 },
              { type: 'Yellow Cards', value: 1 },
              { type: 'Red Cards', value: 0 },
              { type: 'Offsides', value: 2 }
            ] },
            { team: { id: 20, name: 'Boca Juniors' }, statistics: [
              { type: 'Ball Possession', value: '43%' },
              { type: 'Total Shots', value: 6 },
              { type: 'Shots on Goal', value: 2 },
              { type: 'Blocked Shots', value: 1 },
              { type: 'Fouls', value: 11 },
              { type: 'Goalkeeper Saves', value: 2 },
              { type: 'Total passes', value: 168 },
              { type: 'Passes accurate', value: 134 },
              { type: 'Passes %', value: '80%' },
              { type: 'Corner Kicks', value: 3 },
              { type: 'Yellow Cards', value: 2 },
              { type: 'Red Cards', value: 0 },
              { type: 'Offsides', value: 1 }
            ] }
          ],
          players: [
            { team: { id: 10, name: 'Sao Paulo' }, players: [
              { player: { id: 1 }, statistics: [{ tackles: { total: 3, interceptions: 1 } }] },
              { player: { id: 2 }, statistics: [{ tackles: { total: 5, interceptions: 2 } }] }
            ] },
            { team: { id: 20, name: 'Boca Juniors' }, players: [
              { player: { id: 3 }, statistics: [{ tackles: { total: 4, interceptions: 3 } }] },
              { player: { id: 4 }, statistics: [{ tackles: { total: 2, interceptions: 1 } }] }
            ] }
          ]
        }]
      }, { headers: { 'x-ratelimit-requests-remaining': '998' } });
    }
    throw new Error(`URL inesperada ${href}`);
  };

  const result = await fetchApiFootballStatsFallback(espnSummary(), {
    apiKey: 'secret-test',
    fetchImpl: fakeFetch,
    now: Date.parse('2026-09-16T00:45:00Z')
  });

  assert.equal(result.fixtureId, 999001);
  assert.equal(result.source, 'api-football');
  assert.ok(result.metricNames.includes('totalPasses'));
  assert.ok(result.metricNames.includes('tackles'));
  assert.ok(result.metricNames.includes('interceptions'));
  assert.ok(calls.every((call) => call.key === 'secret-test'));
  assert.equal(calls.length, 2, 'live lookup + fixture detail devem bastar quando ids traz statistics/players');

  const home = result.data.boxscore.teams.find((row) => row.homeAway === 'home');
  const away = result.data.boxscore.teams.find((row) => row.homeAway === 'away');
  assert.equal(home.team.id, '123', 'ID ESPN deve ser preservado para o frontend casar o time');
  assert.equal(away.team.id, '456');
  const homeStats = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(homeStats.get('possessionPct'), '57%');
  assert.equal(homeStats.get('totalShots'), '8');
  assert.equal(homeStats.get('accuratePasses'), '191');
  assert.equal(homeStats.get('tackles'), '8');
  assert.equal(homeStats.get('interceptions'), '3');
}

// Depois que o fixture_id foi cacheado pelo gateway, nenhuma nova busca live/date é necessária.
{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/fixtures?ids=999001')) {
      return Response.json({ errors: [], response: [{
        ...apiFixture(),
        statistics: [
          { team: { id: 10, name: 'Sao Paulo' }, statistics: [{ type: 'Total Shots', value: 4 }, { type: 'Corner Kicks', value: 2 }] },
          { team: { id: 20, name: 'Boca Juniors' }, statistics: [{ type: 'Total Shots', value: 3 }, { type: 'Corner Kicks', value: 0 }] }
        ],
        players: []
      }] });
    }
    if (href.includes('/fixtures/players?fixture=999001')) return Response.json({ errors: [], response: [] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchApiFootballStatsFallback(espnSummary(), {
    apiKey: 'secret-test', fetchImpl: fakeFetch, fixtureId: 999001
  });
  assert.equal(result.fixtureId, 999001);
  assert.ok(!calls.some((href) => href.includes('live=all') || href.includes('date=')));
}

console.log('api-football-source: PASS');
