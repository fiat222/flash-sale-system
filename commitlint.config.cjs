// Conventional Commits. Merge-commit messages ("Merge pull request #123 from ...",
// "Merge branch 'x' into y") are skipped automatically via commitlint's built-in
// defaultIgnores — no extra config needed.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [2, 'never', ['upper-case']],
    'header-max-length': [2, 'always', 100],
  },
};
