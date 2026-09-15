# TheNFLEdge
home of G.T.G. NFL Score projection algorithm and historical records

## Weekly archive workflow

The `NFLE26-Archiver` branch adds the weekly finalization and rotation workflow:

1. `npm run fetch:nfl` retrieves ESPN scores and fills completed `FINAL-SCORE-*` markers.
2. `npm run archive:nfl` verifies every game is final, tabulates winner and ATS results, copies the immutable `F` edition into `archives/2026`, and updates the season table.
3. `npm run generate:projections` creates the next upcoming edition and refreshes `nfleTMP.htm`.

`npm run rotate:nfl` runs all three stages in order. The scheduled workflow in `.github/workflows/nfl-weekly.yml` uses the same command and commits the active page, handoff data, and 2026 archive updates.

For an in-progress week, run the manually triggered `NFL In-Progress Score Refresh` workflow from the GitHub Actions tab. It runs only `npm run refresh:scores`, which updates completed score markers and annotations in `nfleTMP.htm` only, while leaving numbered weekly pages, the archive, and rotation untouched.
