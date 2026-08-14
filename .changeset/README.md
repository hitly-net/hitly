# Hitly Changesets

User-facing SDK packages (`hitly.role === "sdk"`) are versioned here. Apps, `@hitly/db`, `@hitly/ui`, and `@hitly/cloud` are ignored and never published.

```bash
yarn changeset
yarn version-packages
```

Do not `changeset publish` until SDK packages emit `dist/` and `private` is flipped. See `.cursor/skills/hitly-release/SKILL.md`.
