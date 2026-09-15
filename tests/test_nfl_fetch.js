const assert = require('assert');
const { annotateCompletedCard } = require('../nfl-fetch');

function annotate(projected, line, score) {
    const block = `<article class="game-card" data-game="NE-SEA"><h2>Game 1</h2><p class="line">Line: ${line} O/U 44.5</p><table><tr><td><b>Projected Score:</b></td><td>${projected}</td></tr><tr><td><b>Final Score:</b></td><td><!--FINAL-SCORE-NE-SEA--></td></tr></table></article>`;
    return annotateCompletedCard(block, new Map([['NE_SEA', {
        scoreString: score,
        awayScore: Number(score.match(/NE (\d+)/)[1]),
        homeScore: Number(score.match(/SEA (\d+)/)[1])
    }]]));
}

const winnerOnly = annotate('NE 17 - SEA 24', 'SEA -3', 'NE 21 - SEA 24');
assert.match(winnerOnly, />NE 21 - SEA 24 W<\/span>/);
assert.doesNotMatch(winnerOnly, /final-score-cover/);

const coverOnly = annotate('NE 24 - SEA 20', 'SEA -3', 'NE 20 - SEA 22');
assert.match(coverOnly, /final-score-cover/);
assert.doesNotMatch(coverOnly, / W<\/span>/);

const winnerAndTotal = annotate('NE 17 - SEA 24', 'SEA -3', 'NE 10 - SEA 31');
assert.match(winnerAndTotal, / W&nbsp;\(T\)<\/span>/);

const rerun = annotateCompletedCard(winnerAndTotal, new Map([['NE_SEA', {
    scoreString: 'NE 10 - SEA 24',
    awayScore: 10,
    homeScore: 24
}]]));
assert.strictEqual((rerun.match(/\bW\b/g) || []).length, 1);
assert.strictEqual((rerun.match(/\(T\)/g) || []).length, 1);

console.log('NFL score annotation tests passed');
