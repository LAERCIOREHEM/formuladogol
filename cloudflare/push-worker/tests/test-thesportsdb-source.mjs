import assert from 'node:assert/strict';
import { fetchTheSportsDbStatsFallback } from '../src/thesportsdb-source.js';

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

{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/searchevents.php?')) {
      return Response.json({ event: [{
        idEvent: '2579902',
        strTimestamp: '2026-09-16T00:30:00',
        strSport: 'Soccer',
        strHomeTeam: 'São Paulo',
        strAwayTeam: 'Boca Juniors'
      }] });
    }
    if (href.includes('/lookupeventstats.php?id=2579902')) {
      return Response.json({ eventstats: [
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Shots on Goal', intHome: '2', intAway: '0' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Total Shots', intHome: '4', intAway: '3' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Blocked Shots', intHome: '1', intAway: '2' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Ball Possession', intHome: '57', intAway: '43' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Corner Kicks', intHome: '2', intAway: '0' }
      ] });
    }
    throw new Error(`URL inesperada ${href}`);
  };

  const result = await fetchTheSportsDbStatsFallback(espnSummary(), {
    fetchImpl: fakeFetch,
    now: Date.parse('2026-09-16T01:00:00Z')
  });

  assert.equal(result.source, 'thesportsdb');
  assert.equal(result.eventId, 2579902);
  assert.ok(result.metricNames.includes('blockedShots'));
  assert.ok(result.metricNames.includes('possessionPct'));
  assert.equal(calls.length, 2, 'busca do evento + estatísticas devem bastar');
  const home = result.data.boxscore.teams.find((row) => row.homeAway === 'home');
  const away = result.data.boxscore.teams.find((row) => row.homeAway === 'away');
  assert.equal(home.team.id, '123');
  assert.equal(away.team.id, '456');
  const homeStats = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(homeStats.get('possessionPct'), '57%');
  assert.equal(homeStats.get('totalShots'), '4');
  assert.equal(homeStats.get('blockedShots'), '1');
}

// Com idEvent cacheado, não deve repetir a busca textual do evento.
{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/lookupeventstats.php?id=2579902')) {
      return Response.json({ eventstats: [
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Total Shots', intHome: '8', intAway: '5' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Blocked Shots', intHome: '2', intAway: '1' }
      ] });
    }
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchTheSportsDbStatsFallback(espnSummary(), {
    fetchImpl: fakeFetch,
    eventId: 2579902
  });
  assert.equal(result.eventId, 2579902);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('searchevents.php'));
}

console.log('thesportsdb-source: PASS');
