const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const SEASON = process.env.NFL_SEASON || '2026';
const HANDOFF_FILE = path.join(ROOT_DIR, 'nfl_data_handoff.json');
const ESPN_BASE_URL = process.env.ESPN_BASE_URL || 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS_BASE_URL = process.env.ODDS_BASE_URL || 'https://api.the-odds-api.com/v4';
const ESPN_API_KEY = process.env.ESPN_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

async function main() {
    const events = (await fetchEvents(SEASON, 2)).filter(event => {
        return new Date(event.date) >= new Date(`${SEASON}-07-01T00:00:00Z`);
    });
    const completedEvents = events.filter(event => event.status?.type?.completed === true);
    const currentWeek = completedEvents.reduce(
        (highest, event) => Math.max(highest, Number(event.week?.number || 0)),
        0
    );
    const upcomingWeeks = events
        .filter(event => event.status?.type?.state === 'pre')
        .map(event => Number(event.week?.number))
        .filter(Number.isFinite);
    const targetWeek = upcomingWeeks.length ? Math.min(...upcomingWeeks) : currentWeek + 1;
    const teamStats = calculateRollingStats(completedEvents);
    let matchups = events
        .filter(event => Number(event.week?.number) === targetWeek && event.status?.type?.state === 'pre')
        .map(toMatchup);

    if (targetWeek === 1) {
        const [previousSeasonEvents, preseasonEvents] = await Promise.all([
            fetchEvents(Number(SEASON) - 1, 2),
            fetchEvents(SEASON, 1)
        ]);
        const historicalGames = buildWeekOneHistory(previousSeasonEvents, preseasonEvents);
        matchups = await mergeOdds(matchups);
        const handoff = {
            season: Number(SEASON),
            current_week: currentWeek,
            target_week: targetWeek,
            model: 'week1-five-game-variant',
            matchups,
            team_stats: historicalGames
        };
        fs.writeFileSync(HANDOFF_FILE, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
        injectCompletedScores(events);
        console.log(`NFL Week 1 data ready: ${matchups.length} matchups, ${Object.keys(historicalGames).length} teams with five-game samples`);
        return;
    }

    const handoff = {
        season: Number(SEASON),
        current_week: currentWeek,
        target_week: targetWeek,
        matchups,
        team_stats: teamStats
    };

    fs.writeFileSync(HANDOFF_FILE, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
    injectCompletedScores(events);
    console.log(`NFL data ready: week ${targetWeek}, ${matchups.length} matchups, ${Object.keys(teamStats).length} teams`);
}

async function fetchEvents(season, seasonType) {
    const url = new URL(ESPN_BASE_URL);
    url.searchParams.set('dates', season);
    url.searchParams.set('seasontype', seasonType);
    url.searchParams.set('limit', '1000');
    if (ESPN_API_KEY) url.searchParams.set('apikey', ESPN_API_KEY);
    const response = await fetch(url, {
        headers: { 'User-Agent': 'TheNFLEdge/2026 (+https://thenfledge.com)' }
    });
    if (!response.ok) throw new Error(`ESPN request failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.events)) throw new Error('ESPN response did not contain an events array');
    return payload.events;
}

function buildWeekOneHistory(previousSeasonEvents, preseasonEvents) {
    const completedPrevious = previousSeasonEvents
        .filter(isCompleted)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    const completedPreseason = preseasonEvents
        .filter(isCompleted)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    const histories = {};

    for (const event of completedPreseason) addEventToHistory(histories, event);
    for (const event of completedPrevious) addEventToHistory(histories, event, 2);

    return Object.fromEntries(Object.entries(histories).map(([team, games]) => {
        const selected = games.slice(-5);
        return [team, {
            pf_sum: selected.reduce((sum, game) => sum + game.pf, 0),
            pa_sum: selected.reduce((sum, game) => sum + game.pa, 0),
            pfpq: selected.reduce((sum, game) => sum + game.pf / 20, 0),
            papq: selected.reduce((sum, game) => sum + game.pa / 20, 0),
            pfpq_avg: selected.reduce((sum, game) => sum + game.pf / 20, 0) / selected.length,
            papq_avg: selected.reduce((sum, game) => sum + game.pa / 20, 0) / selected.length,
            wins: selected.reduce((sum, game) => sum + game.win, 0),
            gp: selected.length,
            sources: selected.map(game => game.source)
        }];
    }));
}

function isCompleted(event) {
    return event.status?.type?.completed === true;
}

function addEventToHistory(histories, event, limitPerTeam = 3) {
    const { home, away } = getTeams(event);
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
    const source = Number(event.season?.year || 0) === Number(SEASON) ? 'current-preseason' : 'previous-regular-season';
    addHistoricalGame(histories, home.team.abbreviation, homeScore, awayScore, source, limitPerTeam);
    addHistoricalGame(histories, away.team.abbreviation, awayScore, homeScore, source, limitPerTeam);
}

function addHistoricalGame(histories, teamName, pointsFor, pointsAgainst, source, limitPerTeam) {
    const team = teamName.toUpperCase();
    if (!histories[team]) histories[team] = [];
    const priorGames = histories[team].filter(game => game.source === source);
    if (priorGames.length >= limitPerTeam) return;
    histories[team].push({
        pf: pointsFor,
        pa: pointsAgainst,
        win: pointsFor > pointsAgainst ? 1 : 0,
        source
    });
}

async function mergeOdds(matchups) {
    if (!ODDS_API_KEY) return matchups;
    const url = new URL(`${ODDS_BASE_URL.replace(/\/$/, '')}/sports/americanfootball_nfl/odds/`);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'spreads,totals');
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('apiKey', ODDS_API_KEY);
    const response = await fetch(url, { headers: { 'User-Agent': 'TheNFLEdge/2026 (+https://thenfledge.com)' } });
    if (!response.ok) throw new Error(`Odds API request failed with HTTP ${response.status}`);
    const oddsEvents = await response.json();
    return matchups.map(matchup => {
        const oddsEvent = oddsEvents.find(event => sameMatchup(event, matchup));
        return oddsEvent ? applyOdds(matchup, oddsEvent) : matchup;
    });
}

function sameMatchup(oddsEvent, matchup) {
    const names = `${oddsEvent.away_team} ${oddsEvent.home_team}`.toUpperCase();
    return names.includes(matchup.away) && names.includes(matchup.home);
}

function applyOdds(matchup, oddsEvent) {
    const bookmaker = oddsEvent.bookmakers?.[0];
    const markets = Object.fromEntries((bookmaker?.markets || []).map(market => [market.key, market.outcomes]));
    const spread = markets.spreads?.find(outcome => outcome.name.toUpperCase().includes(matchup.home));
    const total = markets.totals?.find(outcome => outcome.point != null);
    return {
        ...matchup,
        line: spread?.point != null ? `${matchup.home} ${spread.point > 0 ? '+' : ''}${spread.point}` : matchup.line,
        ou: total?.point ?? matchup.ou,
        odds_source: 'odds-api'
    };
}

function getTeams(event) {
    const competition = event.competitions?.[0];
    const home = competition?.competitors?.find(team => team.homeAway === 'home');
    const away = competition?.competitors?.find(team => team.homeAway === 'away');
    if (!home || !away) throw new Error(`Event ${event.id || 'unknown'} is missing home or away team`);
    return { competition, home, away };
}

function toMatchup(event) {
    const { competition, home, away } = getTeams(event);
    const odds = competition.odds?.[0];
    return {
        event_id: event.id,
        date: event.date,
        away: away.team.abbreviation.toUpperCase(),
        home: home.team.abbreviation.toUpperCase(),
        line: odds?.details || 'TBD',
        ou: odds?.overUnder ?? null
    };
}

function calculateRollingStats(events) {
    const histories = {};
    for (const event of events) {
        const { home, away } = getTeams(event);
        const homeScore = Number(home.score);
        const awayScore = Number(away.score);
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
        addGame(histories, home.team.abbreviation, homeScore, awayScore);
        addGame(histories, away.team.abbreviation, awayScore, homeScore);
    }

    return Object.fromEntries(Object.entries(histories).map(([team, games]) => {
        const lastFour = games.slice(-4);
        return [team.toUpperCase(), {
            pf_sum: lastFour.reduce((sum, game) => sum + game.pf, 0),
            pa_sum: lastFour.reduce((sum, game) => sum + game.pa, 0),
            wins: lastFour.reduce((sum, game) => sum + game.win, 0),
            gp: lastFour.length
        }];
    }));
}

function addGame(histories, teamName, pointsFor, pointsAgainst) {
    const team = teamName.toUpperCase();
    if (!histories[team]) histories[team] = [];
    histories[team].push({ pf: pointsFor, pa: pointsAgainst, win: pointsFor > pointsAgainst ? 1 : 0 });
}

function injectCompletedScores(events) {
    const results = new Map();
    for (const event of events) {
        if (event.status?.type?.completed !== true) continue;
        const { home, away } = getTeams(event);
        const result = `${away.team.abbreviation.toUpperCase()} ${Number(away.score)} - ${home.team.abbreviation.toUpperCase()} ${Number(home.score)}`;
        results.set(`${away.team.abbreviation}_${home.team.abbreviation}`.toUpperCase(), result);
    }

    const files = fs.readdirSync(ROOT_DIR).filter(file => /^nfle(?:TMP|26-\d+)\.htm$/i.test(file));
    for (const file of files) {
        const filePath = path.join(ROOT_DIR, file);
        const html = fs.readFileSync(filePath, 'utf8');
        const updated = html.replace(/<!--FINAL-SCORE-([A-Z0-9]+)-([A-Z0-9]+)-->/gi, (marker, away, home) => {
            return results.get(`${away}_${home}`.toUpperCase()) || marker;
        });
        if (updated !== html) fs.writeFileSync(filePath, updated, 'utf8');
    }
}

main().catch(error => {
    console.error(`NFL fetch failed: ${error.message}`);
    process.exitCode = 1;
});