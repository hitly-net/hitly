---
"@hitly/core": patch
---

Name the file extension in every relative import inside `@hitly/core`, so the package source loads under Node's built-in TypeScript support (for example when the Mastra dev server loads `@hitly/core/destination-check`).
