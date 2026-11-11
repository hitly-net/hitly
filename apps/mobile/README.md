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

## App icons & splash

All launcher icons, the push notification icon and the splash logos are
generated from the SVG sources in [`scripts/icons/brand-svg.ts`](scripts/icons/brand-svg.ts),
which reuse the HITLy mark from the web brand assets (`apps/web/app/icon.svg`:
the "H" glyph + idle-blue check, `#18181b` tile, `#2563eb` accent).

Regenerate after touching the SVG sources:

```bash
yarn workspace @hitly/mobile icons:generate
```

Outputs live in `assets/` and are committed; `src/app-icons.test.ts` asserts
`app.json` points at them with the right sizes (iOS icon must stay alpha-free)
and that the committed PNGs are byte-identical to a fresh render.

- Android adaptive icon: `assets/icons/android-{foreground,background,monochrome}.png`
  (1024px; mark inside the safe zone, monochrome layer for Android 13 themed icons).
- Push notification icon: `assets/icons/notification-icon.png` (96px, white on
  transparent) wired through the `expo-notifications` plugin with tint `#2563eb`.
- Splash: `assets/splash/splash-logo{,-dark}.png` on `#fafafa` / `#18181b`.
- iOS: `assets/icons/ios-icon.png` (1024px, no alpha).

Design: [`docs/mobile.md`](../../docs/mobile.md).
