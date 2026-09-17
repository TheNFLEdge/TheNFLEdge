const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    annotateCompletedCard,
    enforceSequentialTarget,
    loadAndValidateRotationState,
    mergeProviderResults,
    normalizeApiSportsGame,
    normalizeHighlightlyMatch,
    normalizeProviderScore,
    parseTargetOverride,
    resolveTargetWeek
} = require('../nfl-fetch');

function event(week, date, completed = false) {
    return { week: { number: week }, date, status: { type: { completed, state: completed ? 'post' : 'pre' } } };
}

const weekTwoEvents = [
    event(2, '2026-09-18T00:15:00Z'),
    event(2, '2026-09-21T00:20:00Z'),
    event(4, '2026-09-19T00:15:00Z', true),
    event(5, '2026-09-20T00:15:00Z', true),
    event(3, '2026-09-25T00:15:00Z')
];

assert.strictEqual(resolveTargetWeek({
    now: new Date('2026-09-19T12:00:00Z'),
    events: weekTwoEvents,
    activeWeek: 2
}), 2);

assert.strictEqual(resolveTargetWeek({
    now: new Date('2026-09-22T12:00:00Z'),
    events: weekTwoEvents,
    activeWeek: 2
}), 3);

assert.strictEqual(resolveTargetWeek({
    now: new Date('2026-09-15T12:00:00Z'),
    events: [event(1, '2026-09-10T00:15:00Z'), event(2, '2026-09-18T00:15:00Z')],
    activeWeek: 1,
    leadDays: 3
}), 2);

assert.throws(() => enforceSequentialTarget(2, 5), /exactly one week/);
assert.strictEqual(resolveTargetWeek({ now: new Date(), events: weekTwoEvents, activeWeek: 2, override: '2' }), 2);
for (const value of ['0', '-1', 'two', '2.5', '19', '']) {
    assert.throws(() => parseTargetOverride(value), /Invalid NFL_TARGET_WEEK/);
}

assert.deepStrictEqual(normalizeProviderScore('New England Patriots', 'Seattle Seahawks', 10, 13, 'test'), {
    source: 'test', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13'
});
assert.deepStrictEqual(normalizeApiSportsGame({
    game: { status: { short: 'FT' }, teams: { away: { name: 'New England Patriots' }, home: { name: 'Seattle Seahawks' } }, scores: { away: { total: 10 }, home: { total: 13 } } }
}), {
    source: 'api-sports', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13'
});
assert.deepStrictEqual(normalizeHighlightlyMatch({
    completed: true, awayTeam: { name: 'New England Patriots', score: 10 }, homeTeam: { name: 'Seattle Seahawks', score: 13 }
}), {
    source: 'highlightly', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13'
});
assert.strictEqual(normalizeApiSportsGame({
    game: { status: { short: 'Q3' }, teams: { away: { name: 'New England Patriots' }, home: { name: 'Seattle Seahawks' } }, scores: { away: { total: 10 }, home: { total: 13 } } }
}), null);
assert.strictEqual(mergeProviderResults([
    { source: 'api-sports', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13' },
    { source: 'highlightly', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13' }
], ['NE_SEA']).size, 1);
assert.throws(() => mergeProviderResults([
    { source: 'api-sports', away: 'NE', home: 'SEA', awayScore: 10, homeScore: 13, scoreString: 'NE 10 - SEA 13' },
    { source: 'highlightly', away: 'NE', home: 'SEA', awayScore: 14, homeScore: 13, scoreString: 'NE 14 - SEA 13' }
], ['NE_SEA']), /Fallback score disagreement/);

function annotatedCard(projected, line, score) {
    const block = `<article class="game-card" data-game="NE-SEA"><h2>Game 1</h2><p class="line">Line: ${line} O/U 44.5</p><table><tr><td><b>Projected Score:</b></td><td>${projected}</td></tr><tr><td><b>Final Score:</b></td><td><!--FINAL-SCORE-NE-SEA--></td></tr></table></article>`;
    return annotateCompletedCard(block, new Map([['NE_SEA', {
        scoreString: score,
        awayScore: Number(score.match(/NE (\d+)/)[1]),
        homeScore: Number(score.match(/SEA (\d+)/)[1])
    }]]));
}

const winnerAndTotal = annotatedCard('NE 17 - SEA 24', 'SEA -3', 'NE 10 - SEA 31');
assert.match(winnerAndTotal, / W&nbsp;\(U\)<\/span>/);
const rerun = annotateCompletedCard(winnerAndTotal, new Map([['NE_SEA', {
    scoreString: 'NE 10 - SEA 24',
    awayScore: 10,
    homeScore: 24
}]]));
assert.strictEqual((rerun.match(/\bW\b/g) || []).length, 1);
assert.strictEqual((rerun.match(/\((O|U)\)/g) || []).length, 1);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfl-rotation-'));
const issue = '<h1>Week 2 Picks</h1>\r\n<article class="game-card"></article>';
const issuePath = path.join(temporaryRoot, 'nfle26-02.htm');
fs.writeFileSync(issuePath, issue);
const hash = crypto.createHash('sha256').update(issue.replace(/\r\n/g, '\n')).digest('hex');
fs.writeFileSync(path.join(temporaryRoot, 'nfl_rotation_state.json'), JSON.stringify({
    schema_version: 1,
    season: 2026,
    active_week: 2,
    active_issue: 'nfle26-02.htm',
    active_issue_sha256: hash,
    generated_at: '2026-09-16T03:30:00Z',
    generated_by: 'rotation',
    viewport: 'nfleTMP.htm'
}));
assert.strictEqual(loadAndValidateRotationState(temporaryRoot, 2026).state.active_week, 2);
fs.writeFileSync(path.join(temporaryRoot, 'nfle26-05.htm'), '<h1>Week 5 Picks</h1>');
fs.writeFileSync(path.join(temporaryRoot, 'nfleTMP.htm'), '<h1>corrupted viewport</h1>');
assert.strictEqual(loadAndValidateRotationState(temporaryRoot, 2026).state.active_issue, 'nfle26-02.htm');
fs.appendFileSync(issuePath, 'changed');
assert.throws(() => loadAndValidateRotationState(temporaryRoot, 2026), /SHA-256/);
fs.rmSync(temporaryRoot, { recursive: true, force: true });

console.log('NFL rotation and score annotation tests passed');
