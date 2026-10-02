// Root-level re-export of the analyst tool plugin.
//
// Exists so a path-based Cordis loader row (profiles/data-analyst/cordis.patch.yml's
// dev-boot `data-analyst-viz` row) resolves its dsh.client face to this repo's
// root package.json — the declared owner (see packages/dsh-data-viz/client.js) —
// instead of packages/dsh-data-viz/package.json. Client-face discovery walks up
// from the resolved module file to its *nearest* ancestor package.json; a row
// pointing straight into packages/dsh-data-viz/ would stop there rather than at
// root. This file has no package.json above it before the repo root's own.
export * from './packages/dsh-data-viz/dist/index.js'
