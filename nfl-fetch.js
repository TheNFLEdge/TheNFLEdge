const fs = require('fs');
const path = require('path');
const {
    copyAtomic,
    enforceSequentialTarget,
    loadAndValidateRotationState,
    parseTargetOverride,
    parseWeekHeading,
    resolveTargetWeek,
    scheduleWindows,
    sha256File,
    writeJsonAtomic,
    writeRotationState
} = require('./nfl-rotation');

const ROOT_DIR = process.cwd();
const SEASON = process.env.NFL_SEASON || '2026';
const HANDOFF_FILE = path.join(ROOT_DIR, 'nfl_data_handoff.json');
const ESPN_BASE_URL = process.env.ESPN_BASE_URL || 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS_BASE_URL = process.env.ODDS_BASE_URL || 'https://api.the-odds-api.com/v4';
const ESPN_API_KEY = process.env.ESPN_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const API_SPORTS_KEY = process.env.API_SPORTS_KEY;
const API_SPORTS_BASE_URL = process.env.API_SPORTS_BASE_URL || 'https://v1.american-football.api-sports.io';
const HIGHLIGHTLY_API_KEY = process.env.HIGHLIGHTLY_API_KEY;
const HIGHLIGHTLY_BASE_URL = process.env.HIGHLIGHTLY_BASE_URL;
const HIGHLIGHTLY_HOST = process.env.HIGHLIGHTLY_HOST || 'nfl-ncaa-highlights-api.p.rapidapi.com';
async function main(mode = getMode()) {
    if (mode === 'refresh') return refreshScores();
    if (mode === 'restore-viewport') return restoreViewport();
    if (mode === 'recover-rotation') return recoverRotation();
    if (mode !== 'rotate') throw new Error(`Unsupported mode: ${mode}`);

    const { state, issuePath } = loadAndValidateRotationState(ROOT_DIR, Number(SEASON));
    const events = (await fetchEvents(SEASON, 2)).filter(event => {
        return new Date(event.date) >= new Date(`${SEASON}-07-01T00:00:00Z`);
    });
    const completedEvents = events.filter(event => event.status?.type?.completed === true);
    const targetWeek = resolveTargetWeek({
        now: process.env.NFL_NOW_OVERRIDE || new Date(),
        events,
        activeWeek: state.active_week,
        override: process.env.NFL_TARGET_WEEK,
        leadDays: Number(process.env.NFL_WEEK_LEAD_DAYS || 3),
        graceHours: Number(process.env.NFL_WEEK_GRACE_HOURS || 12)
    });
    enforceSequentialTarget(state.active_week, targetWeek, process.env.NFL_ALLOW_NONSEQUENTIAL_RECOVERY === 'true');
    const teamStats = calculateRollingStats(completedEvents);
    let matchups = events
        .filter(event => Number(event.week?.number) === targetWeek && event.status?.type?.state === 'pre')
        .map(toMatchup);

    const canonicalHtml = fs.readFileSync(issuePath, 'utf8');
    let scoreResults = scoreResultsFromEvents(completedEvents);
    let finalizedHtml = annotateHtml(canonicalHtml, scoreResults);
    if (!isCompleteCanonical(finalizedHtml)) {
        const fallbackResults = await fetchFallbackScores(finalizedHtml);
        scoreResults = mergeScoreResults(scoreResults, fallbackResults);
        finalizedHtml = annotateHtml(canonicalHtml, scoreResults);
    }
    if (targetWeek === state.active_week || !isCompleteCanonical(finalizedHtml)) {
        writeViewportFromCanonical(canonicalHtml, completedEvents);
        throw new Error(`Active Week ${state.active_week} is not complete; no archive or next-week generation was performed.`);
    }
    writeAtomic(issuePath, finalizedHtml);
    const finalizedState = {
        ...state,
        active_issue_sha256: sha256File(issuePath),
        generated_at: new Date().toISOString(),
        generated_by: 'finalize'
    };
    writeJsonAtomic(path.join(ROOT_DIR, 'nfl_rotation_state.json'), finalizedState);

    if (targetWeek === 1) {
        const [previousSeasonEvents, preseasonEvents] = await Promise.all([
            fetchEvents(Number(SEASON) - 1, 2),
            fetchEvents(SEASON, 1)
        ]);
        const historicalGames = buildWeekOneHistory(previousSeasonEvents, preseasonEvents);
        matchups = await mergeOdds(matchups);
        const handoff = {
            season: Number(SEASON),
            active_week: state.active_week,
            target_week: targetWeek,
            target_week_source: process.env.NFL_TARGET_WEEK ? 'override' : 'date',
            generated_at: new Date().toISOString(),
            mode: 'rotate',
            model: 'week1-five-game-variant',
            matchups,
            team_stats: historicalGames
        };
        writeJsonAtomic(HANDOFF_FILE, handoff);
        console.log(`NFL Week 1 data ready: ${matchups.length} matchups, ${Object.keys(historicalGames).length} teams with five-game samples`);
        return;
    }

    const handoff = {
        season: Number(SEASON),
        active_week: state.active_week,
        target_week: targetWeek,
        target_week_source: process.env.NFL_TARGET_WEEK ? 'override' : 'date',
        generated_at: new Date().toISOString(),
        mode: 'rotate',
        resolver: {
            now: new Date(process.env.NFL_NOW_OVERRIDE || Date.now()).toISOString(),
            lead_days: Number(process.env.NFL_WEEK_LEAD_DAYS || 3),
            grace_hours: Number(process.env.NFL_WEEK_GRACE_HOURS || 12)
        },
        matchups,
        team_stats: teamStats
    };

    writeJsonAtomic(HANDOFF_FILE, handoff);
    console.log(`NFL data ready: week ${targetWeek}, ${matchups.length} matchups, ${Object.keys(teamStats).length} teams`);
}

function getMode() {
    const modeArgument = process.argv.find(argument => argument.startsWith('--mode='));
    return modeArgument ? modeArgument.slice('--mode='.length) : 'rotate';
}

async function refreshScores() {
    const viewportPath = path.join(ROOT_DIR, 'nfleTMP.htm');
    if (!fs.existsSync(viewportPath)) throw new Error('Refresh failed: nfleTMP.htm is missing. Run npm run restore:viewport.');
    const original = fs.readFileSync(viewportPath, 'utf8');
    parseWeekHeading(original, 'nfleTMP.htm');
    if (!/<article\b[^>]*class=["'][^"']*\bgame-card\b/i.test(original)) {
        throw new Error('Refresh failed: nfleTMP.htm is malformed or contains no game cards. Run npm run restore:viewport.');
    }
    const events = await fetchEvents(SEASON, 2);
    let scoreResults = scoreResultsFromEvents(events.filter(isCompleted));
    let updated = annotateHtml(original, scoreResults);
    if (!isCompleteCanonical(updated)) {
        const fallbackResults = await fetchFallbackScores(updated);
        scoreResults = mergeScoreResults(scoreResults, fallbackResults);
        updated = annotateHtml(original, scoreResults);
    }
    writeAtomic(viewportPath, updated);
    console.log('NFL viewport refreshed: nfleTMP.htm only');
}

async function restoreViewport() {
    const { issuePath } = loadAndValidateRotationState(ROOT_DIR, Number(SEASON));
    copyAtomic(issuePath, path.join(ROOT_DIR, 'nfleTMP.htm'));
    console.log('NFL viewport restored from the validated canonical issue');
}

function recoverRotation() {
    const weekArgument = process.argv.find(argument => argument.startsWith('--week='));
    const week = Number(weekArgument?.slice('--week='.length));
    if (!/^\d+$/.test(weekArgument?.slice('--week='.length) || '') || week < 1 || week > 18) {
        throw new Error('Recovery requires an explicit --week=NN argument from 1 through 18.');
    }
    if (process.env.NFL_CONFIRM_ROTATION_RECOVERY !== 'yes') {
        throw new Error('Recovery requires NFL_CONFIRM_ROTATION_RECOVERY=yes.');
    }
    const issuePath = path.join(ROOT_DIR, `nfle26-${String(week).padStart(2, '0')}.htm`);
    if (!fs.existsSync(issuePath)) throw new Error(`Recovery failed: ${path.basename(issuePath)} does not exist.`);
    parseWeekHeading(fs.readFileSync(issuePath, 'utf8'), path.basename(issuePath));
    writeRotationState(ROOT_DIR, week, 'recovery');
    console.log(`Rotation state recovered for Week ${week}`);
}

function writeAtomic(filePath, content) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function writeViewportFromCanonical(canonicalHtml, events) {
    writeAtomic(path.join(ROOT_DIR, 'nfleTMP.htm'), annotateHtml(canonicalHtml, scoreResultsFromEvents(events)));
}

function annotateHtml(html, results) {
    const scoreResults = results instanceof Map ? results : scoreResultsFromEvents(results);
    return html.replace(
        /<article\b[^>]*class=["'][^"']*\bgame-card\b[^"']*["'][\s\S]*?<\/article>/gi,
        block => annotateCompletedCard(block, scoreResults)
    );
}

function scoreResultsFromEvents(events) {
    const results = new Map();
    for (const event of events) {
        const { home, away } = getTeams(event);
        const awayScore = Number(away.score);
        const homeScore = Number(home.score);
        if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
        results.set(`${away.team.abbreviation}_${home.team.abbreviation}`.toUpperCase(), {
            source: 'espn',
            away: away.team.abbreviation.toUpperCase(),
            home: home.team.abbreviation.toUpperCase(),
            scoreString: `${away.team.abbreviation.toUpperCase()} ${awayScore} - ${home.team.abbreviation.toUpperCase()} ${homeScore}`,
            awayScore,
            homeScore
        });
    }
    return results;
}

async function fetchFallbackScores(html) {
    const missing = missingMatchups(html);
    if (!missing.length) return new Map();
    const providerResults = [];
    if (API_SPORTS_KEY) providerResults.push(fetchApiSportsScores());
    if (HIGHLIGHTLY_API_KEY && HIGHLIGHTLY_BASE_URL) providerResults.push(fetchHighlightlyScores());
    if (!providerResults.length) return new Map();
    const responses = await Promise.allSettled(providerResults);
    const successfulResults = responses
        .filter(response => response.status === 'fulfilled')
        .flatMap(response => response.value);
    return mergeProviderResults(successfulResults, missing);
}

function missingMatchups(html) {
    const missing = [];
    const cards = html.match(/<article\b[^>]*class=["'][^"']*\bgame-card\b[^"']*["'][\s\S]*?<\/article>/gi) || [];
    for (const card of cards) {
        if (!/FINAL-SCORE-[A-Z0-9]+-[A-Z0-9]+/i.test(card)) continue;
        const matchup = /data-game=["']([A-Z0-9]+)-([A-Z0-9]+)["']/i.exec(card);
        if (matchup) missing.push(`${matchup[1].toUpperCase()}_${matchup[2].toUpperCase()}`);
    }
    return missing;
}

function mergeScoreResults(primary, fallback) {
    const merged = new Map(primary);
    for (const [key, result] of fallback) {
        const existing = merged.get(key);
        if (existing && (existing.awayScore !== result.awayScore || existing.homeScore !== result.homeScore)) {
            throw new Error(`Score provider disagreement for ${key}: ${existing.source} reported ${existing.scoreString}; ${result.source} reported ${result.scoreString}.`);
        }
        if (!existing) merged.set(key, result);
    }
    return merged;
}

function mergeProviderResults(providerResults, missingKeys) {
    const merged = new Map();
    for (const result of providerResults) {
        const key = `${result.away}_${result.home}`;
        if (!missingKeys.includes(key)) continue;
        const existing = merged.get(key);
        if (existing && (existing.awayScore !== result.awayScore || existing.homeScore !== result.homeScore)) {
            throw new Error(`Fallback score disagreement for ${key}: ${existing.source} reported ${existing.scoreString}; ${result.source} reported ${result.scoreString}.`);
        }
        merged.set(key, result);
    }
    return merged;
}

async function fetchApiSportsScores() {
    const url = new URL(`${API_SPORTS_BASE_URL.replace(/\/$/, '')}/games`);
    url.searchParams.set('league', '1');
    url.searchParams.set('season', SEASON);
    const response = await fetch(url, { headers: { 'x-apisports-key': API_SPORTS_KEY } });
    if (!response.ok) throw new Error(`API-Sports score request failed with HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.response || []).map(normalizeApiSportsGame).filter(Boolean);
}

async function fetchHighlightlyScores() {
    const dates = Array.from({ length: 4 }, (_, index) => {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - index);
        return date.toISOString().slice(0, 10);
    });
    const responses = await Promise.all(dates.map(async date => {
        const url = new URL(`${HIGHLIGHTLY_BASE_URL.replace(/\/$/, '')}/matches`);
        url.searchParams.set('date', date);
        const response = await fetch(url, { headers: { 'x-rapidapi-key': HIGHLIGHTLY_API_KEY, 'x-rapidapi-host': HIGHLIGHTLY_HOST } });
        if (!response.ok) throw new Error(`Highlightly score request failed with HTTP ${response.status}`);
        return response.json();
    }));
    return responses.flatMap(payload => (payload.data || payload.matches || payload.response || []).map(normalizeHighlightlyMatch).filter(Boolean));
}

function normalizeApiSportsGame(game) {
    const away = game.game?.teams?.away?.name || game.teams?.away?.name;
    const home = game.game?.teams?.home?.name || game.teams?.home?.name;
    const awayScore = Number(game.game?.scores?.away?.total ?? game.scores?.away?.total);
    const homeScore = Number(game.game?.scores?.home?.total ?? game.scores?.home?.total);
    const status = game.game?.status?.short || game.status?.short || game.game?.status?.long || game.status?.long;
    return normalizeProviderScore(away, home, awayScore, homeScore, 'api-sports', isFinalProviderStatus(status));
}

function normalizeHighlightlyMatch(match) {
    const away = match.awayTeam?.name || match.away?.name || match.teams?.away?.name || match.awayTeam;
    const home = match.homeTeam?.name || match.home?.name || match.teams?.home?.name || match.homeTeam;
    const awayScore = Number(match.awayTeam?.score ?? match.away?.score ?? match.scores?.away);
    const homeScore = Number(match.homeTeam?.score ?? match.home?.score ?? match.scores?.home);
    const status = match.status?.short || match.status?.type || match.status;
    const completed = match.completed === true || match.isFinished === true || isFinalProviderStatus(status);
    return normalizeProviderScore(away, home, awayScore, homeScore, 'highlightly', completed);
}

function isFinalProviderStatus(status) {
    return /^(AOT|COMPLETED|FINAL|FINISHED|FT|POST|FINAL\/OT)$/i.test(String(status || '').trim());
}

const TEAM_ALIASES = {
    'NEW ENGLAND PATRIOTS': 'NE', 'SEATTLE SEAHAWKS': 'SEA', 'SAN FRANCISCO 49ERS': 'SF',
    'LOS ANGELES RAMS': 'LAR', 'TAMPA BAY BUCCANEERS': 'TB', 'CINCINNATI BENGALS': 'CIN',
    'NEW ORLEANS SAINTS': 'NO', 'DETROIT LIONS': 'DET', 'NEW YORK JETS': 'NYJ', 'TENNESSEE TITANS': 'TEN',
    'BALTIMORE RAVENS': 'BAL', 'INDIANAPOLIS COLTS': 'IND', 'ATLANTA FALCONS': 'ATL', 'PITTSBURGH STEELERS': 'PIT',
    'CHICAGO BEARS': 'CHI', 'CAROLINA PANTHERS': 'CAR', 'CLEVELAND BROWNS': 'CLE', 'JACKSONVILLE JAGUARS': 'JAX',
    'BUFFALO BILLS': 'BUF', 'HOUSTON TEXANS': 'HOU', 'MIAMI DOLPHINS': 'MIA', 'LAS VEGAS RAIDERS': 'LV',
    'GREEN BAY PACKERS': 'GB', 'MINNESOTA VIKINGS': 'MIN', 'WASHINGTON COMMANDERS': 'WSH', 'PHILADELPHIA EAGLES': 'PHI',
    'ARIZONA CARDINALS': 'ARI', 'LOS ANGELES CHARGERS': 'LAC', 'DALLAS COWBOYS': 'DAL', 'NEW YORK GIANTS': 'NYG',
    'DENVER BRONCOS': 'DEN', 'KANSAS CITY CHIEFS': 'KC'
};

function normalizeTeam(value) {
    const text = String(value || '').trim().toUpperCase();
    return TEAM_ALIASES[text] || text;
}

function normalizeProviderScore(away, home, awayScore, homeScore, source, completed = true) {
    const awayAbbreviation = normalizeTeam(away);
    const homeAbbreviation = normalizeTeam(home);
    if (!completed || !/^[A-Z0-9]{2,4}$/.test(awayAbbreviation) || !/^[A-Z0-9]{2,4}$/.test(homeAbbreviation) || !Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;
    return { source, away: awayAbbreviation, home: homeAbbreviation, awayScore, homeScore, scoreString: `${awayAbbreviation} ${awayScore} - ${homeAbbreviation} ${homeScore}` };
}

function isCompleteCanonical(html) {
    const cards = html.match(/<article\b[^>]*class=["'][^"']*\bgame-card\b[^"']*["'][\s\S]*?<\/article>/gi) || [];
    return cards.length > 0 && cards.every(card => !/FINAL-SCORE-[A-Z0-9]+-[A-Z0-9]+/i.test(card));
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
    const atsCorrect = projectedCover !== 0
        && (actualCover === 0 || Math.sign(projectedCover) === Math.sign(actualCover));
    const projectedTotal = projectedAway + projectedHome;
    const actualTotal = actualAway + actualHome;
    const totalMarker = projectedTotal > overUnder && actualTotal > overUnder
        ? '&nbsp;(O)'
        : projectedTotal < overUnder && actualTotal < overUnder
            ? '&nbsp;(U)'
            : '';

    const markers = `${winnerCorrect ? ' W' : ''}${totalMarker}`;
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

module.exports = {
    annotateCompletedCard,
    enforceSequentialTarget,
    loadAndValidateRotationState,
    mergeProviderResults,
    normalizeApiSportsGame,
    normalizeHighlightlyMatch,
    normalizeProviderScore,
    parseTargetOverride,
    resolveTargetWeek,
    scheduleWindows
};