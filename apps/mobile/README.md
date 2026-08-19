# HITLy mobile

Expo reviewer app for iOS and Android. Sign into HITLy Cloud or a hosted instance, get notified, and open the work item that needs a decision.

```bash
yarn install
yarn db:migrate
yarn dev:app
yarn dev:mobile
```

Scan the QR code with Expo Go, or press `i` / `a` for a simulator. Web preview needs a real browser at http://localhost:8081 — Cursor’s Simple Browser is blocked by Expo CORS (`vscode-file://`).

Restart Metro after installing packages (`Ctrl+C`, then `yarn dev:mobile`).

Design: [`docs/mobile.md`](../../docs/mobile.md).
