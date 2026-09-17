const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE_NAME = 'nfl_rotation_state.json';
const ISSUE_PATTERN = /^nfle26-([0-9]{2})\.htm$/;

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseWeekHeading(html, fileName) {
    const match = /<h1>\s*Week\s+(\d+)\s+Picks\s*<\/h1>/i.exec(html);
    if (!match) throw new Error(`Canonical issue ${fileName} is missing a parseable <h1>Week N Picks</h1> heading`);
    return Number(match[1]);
}

function expectedIssue(week) {
    return `nfle26-${String(week).padStart(2, '0')}.htm`;
}

function loadAndValidateRotationState(rootDir, season = Number(process.env.NFL_SEASON || 2026)) {
    const statePath = path.join(rootDir, STATE_FILE_NAME);
    if (!fs.existsSync(statePath)) {
        throw new Error('Rotation state validation failed: nfl_rotation_state.json is missing. Run the documented recovery command.');
    }
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
        throw new Error(`Rotation state validation failed: nfl_rotation_state.json is not valid JSON (${error.message}).`);
    }
    if (state.schema_version !== 1) throw new Error('Rotation state validation failed: unsupported schema_version.');
    if (state.season !== season) throw new Error(`Rotation state validation failed: season ${state.season} does not match NFL_SEASON ${season}.`);
    if (!Number.isInteger(state.active_week) || state.active_week < 1 || state.active_week > 18) {
        throw new Error('Rotation state validation failed: active_week must be an integer from 1 through 18.');
    }
    if (typeof state.active_issue !== 'string' || !ISSUE_PATTERN.test(state.active_issue) || state.active_issue !== expectedIssue(state.active_week)) {
        throw new Error('Rotation state validation failed: active_issue is not the safe filename expected for active_week.');
    }
    const issuePath = path.join(rootDir, state.active_issue);
    if (!fs.existsSync(issuePath)) throw new Error(`Rotation state validation failed: canonical issue ${state.active_issue} does not exist.`);
    const html = fs.readFileSync(issuePath, 'utf8');
    if (parseWeekHeading(html, state.active_issue) !== state.active_week) {
        throw new Error(`Rotation state validation failed: ${state.active_issue} heading does not match active_week ${state.active_week}.`);
    }
    const actualHash = sha256File(issuePath);
    if (actualHash !== state.active_issue_sha256) {
        throw new Error(`Rotation state validation failed: ${state.active_issue} SHA-256 does not match the recorded checksum. Restore the canonical issue or run the documented explicit recovery command.`);
    }
    return { state, issuePath, statePath };
}

function writeJsonAtomic(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function writeRotationState(rootDir, activeWeek, generatedBy = 'rotation') {
    const issue = expectedIssue(activeWeek);
    const issuePath = path.join(rootDir, issue);
    const state = {
        schema_version: 1,
        season: Number(process.env.NFL_SEASON || 2026),
        active_week: activeWeek,
        active_issue: issue,
        active_issue_sha256: sha256File(issuePath),
        generated_at: new Date().toISOString(),
        generated_by: generatedBy,
        viewport: 'nfleTMP.htm'
    };
    writeJsonAtomic(path.join(rootDir, STATE_FILE_NAME), state);
    return state;
}

function parseTargetOverride(value) {
    if (value === undefined) return undefined;
    if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid NFL_TARGET_WEEK: ${value}. Use an integer from 1 through 18.`);
    const week = Number(value);
    if (week < 1 || week > 18) throw new Error(`Invalid NFL_TARGET_WEEK: ${value}. Use an integer from 1 through 18.`);
    return week;
}

function scheduleWindows(events) {
    const windows = new Map();
    for (const event of events) {
        const week = Number(event.week?.number);
        const date = new Date(event.date);
        if (!Number.isInteger(week) || week < 1 || week > 18 || Number.isNaN(date.valueOf())) continue;
        const window = windows.get(week) || { week, start: date, end: date };
        if (date < window.start) window.start = date;
        if (date > window.end) window.end = date;
        windows.set(week, window);
    }
    return [...windows.values()].sort((a, b) => a.week - b.week);
}

function resolveTargetWeek({ now = new Date(), events, activeWeek, override, leadDays = 3, graceHours = 12 }) {
    const explicit = parseTargetOverride(override);
    if (explicit !== undefined) return explicit;
    const windows = scheduleWindows(events);
    const activeWindow = windows.find(window => window.week === activeWeek);
    const nextWeek = activeWeek + 1;
    const nextWindow = windows.find(window => window.week === nextWeek);
    if (!activeWindow || !nextWindow) throw new Error(`Date resolver could not find schedule windows for Week ${activeWeek} and Week ${nextWeek}.`);
    const currentTime = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(currentTime.valueOf())) throw new Error('Date resolver received an invalid current time.');
    const graceEnd = new Date(activeWindow.end.getTime() + graceHours * 60 * 60 * 1000);
    if (currentTime <= graceEnd) return activeWeek;
    const leadStart = new Date(nextWindow.start.getTime() - leadDays * 24 * 60 * 60 * 1000);
    return currentTime >= leadStart ? nextWeek : activeWeek;
}

function enforceSequentialTarget(activeWeek, targetWeek, allowNonSequential = false) {
    if (targetWeek < activeWeek || targetWeek > activeWeek + 1) {
        if (allowNonSequential) return;
        throw new Error(`Sequential rotation refused target Week ${targetWeek} for active Week ${activeWeek}; normal rotation may advance exactly one week.`);
    }
    return targetWeek;
}

function copyAtomic(source, destination) {
    const temporaryPath = `${destination}.${process.pid}.tmp`;
    fs.copyFileSync(source, temporaryPath);
    fs.renameSync(temporaryPath, destination);
}

module.exports = {
    STATE_FILE_NAME,
    expectedIssue,
    enforceSequentialTarget,
    loadAndValidateRotationState,
    parseTargetOverride,
    parseWeekHeading,
    resolveTargetWeek,
    scheduleWindows,
    sha256File,
    writeJsonAtomic,
    writeRotationState,
    copyAtomic
};
