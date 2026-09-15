const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const SEASON = process.env.NFL_SEASON || '2026';
const HANDOFF_FILE = path.join(ROOT_DIR, 'nfl_data_handoff.json');
const ESPN_BASE_URL = process.env.ESPN_BASE_URL || 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS_BASE_URL = process.env.ODDS_BASE_URL || 'https://api.the-odds-api.com/v4';
const ESPN_API_KEY = process.env.ESPN_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SCORE_REFRESH_FILES = process.env.NFL_SCORE_REFRESH_FILES
    ? process.env.NFL_SCORE_REFRESH_FILES.split(',').map(file => file.trim()).filter(Boolean)
    : null;

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
        results.set(`${away.team.abbreviation}_${home.team.abbreviation}`.toUpperCase(), {
            scoreString: result,
            awayScore: Number(away.score),
            homeScore: Number(home.score)
        });
    }

    const files = fs.readdirSync(ROOT_DIR).filter(file => {
        if (SCORE_REFRESH_FILES) return SCORE_REFRESH_FILES.includes(file);
        return /^nfle(?:TMP|26-\d+)\.htm$/i.test(file);
    });
    for (const file of files) {
        const filePath = path.join(ROOT_DIR, file);
        const html = fs.readFileSync(filePath, 'utf8');
        const updated = html.replace(
            /<article\b[^>]*class=["'][^"']*\bgame-card\b[^"']*["'][\s\S]*?<\/article>/gi,
            block => annotateCompletedCard(block, results)
        );
        if (updated !== html) fs.writeFileSync(filePath, updated, 'utf8');
    }
}

function annotateCompletedCard(block, results) {
    const matchupMatch = /data-game=["']([A-Z0-9]+)-([A-Z0-9]+)["']/i.exec(block);
    if (!matchupMatch) return block;

    const away = matchupMatch[1].toUpperCase();
    const home = matchupMatch[2].toUpperCase();
    const gameData = results.get(`${away}_${home}`.toUpperCase());
    if (!gameData) return block;

    const projectedMatch = /Projected Score:<\/b><\/td>\s*<td[^>]*>\s*[A-Z0-9]+\s+(-?\d+)\s*-\s*[A-Z0-9]+\s+(-?\d+)\s*<\/td>/i.exec(block);
    const lineMatch = /Line:\s*([A-Z0-9]+)\s+([+-]\d+(?:\.\d+)?)\s+O\/U\s+(\d+(?:\.\d+)?)/i.exec(block);
    if (!projectedMatch || !lineMatch) return replaceFinalScore(block, gameData.scoreString);

    const projectedAway = Number(projectedMatch[1]);
    const projectedHome = Number(projectedMatch[2]);
    const spreadTeam = lineMatch[1].toUpperCase();
    const spread = Number(lineMatch[2]);
    const overUnder = Number(lineMatch[3]);
    const actualAway = gameData.awayScore;
    const actualHome = gameData.homeScore;

    const projectedMargin = projectedAway - projectedHome;
    const actualMargin = actualAway - actualHome;
    const winnerCorrect = projectedMargin !== 0 && actualMargin !== 0 && Math.sign(projectedMargin) === Math.sign(actualMargin);
    const projectedSpreadMargin = spreadTeam === away ? projectedAway - projectedHome : projectedHome - projectedAway;
    const actualSpreadMargin = spreadTeam === away ? actualAway - actualHome : actualHome - actualAway;
    const projectedCover = projectedSpreadMargin + spread;
    const actualCover = actualSpreadMargin + spread;
    const atsCorrect = projectedCover !== 0 && actualCover !== 0 && Math.sign(projectedCover) === Math.sign(actualCover);
    const projectedTotal = projectedAway + projectedHome;
    const actualTotal = actualAway + actualHome;
    const totalCorrect = projectedTotal !== overUnder && actualTotal !== overUnder
        && Math.sign(projectedTotal - overUnder) === Math.sign(actualTotal - overUnder);

    const markers = `${winnerCorrect ? ' W' : ''}${totalCorrect ? '&nbsp;(T)' : ''}`;
    const scoreMarkup = atsCorrect
        ? `<span class="final-score final-score-cover" style="color: green; font-weight: 700">${gameData.scoreString}${markers}</span>`
        : `<span class="final-score">${gameData.scoreString}${markers}</span>`;
    return replaceFinalScore(block, scoreMarkup);
}

function replaceFinalScore(block, replacement) {
    return block.replace(
        /(<tr>\s*<td><b>Final Score:<\/b><\/td>\s*<td[^>]*>)[\s\S]*?(<\/td>\s*<\/tr>)/i,
        `$1${replacement}$2`
    );
}

if (require.main === module) {
    main().catch(error => {
        console.error(`NFL fetch failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { annotateCompletedCard };