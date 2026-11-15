# Request your data (UK GDPR)

Signed-in users can ask HITLy for a copy of their personal data at any time:
**Settings → Profile → Your data → Request my data**. The app does **not**
serve the data itself — clicking the button records a support request, and a
support engineer prepares the export and sends it to the account's email by
hand.

## What the request records

Each request is one row in the `support_requests` table:

| Field | Meaning |
| --- | --- |
| `user_id` | who asked (from the verified session — never from the request body) |
| `workspace_id` | the active workspace the ask came from, after the user's membership is verified in the database (`null` when there is none) |
| `type` | `data` for data requests (the table is generic for other support asks) |
| `status` | `open` while support owes the export, then `fulfilled` / `cancelled` |
| `created_at` | when the user asked |

The row stores only ids and timestamps — no personal data, no export content.

## Behaviour

- **Confirmation**: the app confirms on screen and names the UK GDPR
  response deadline — you receive your data within **one month** of the
  request (the ICO calendar-month convention, rendered as a date).
- **Idempotent**: an already-open request is returned as-is; repeated clicks
  (even concurrent ones) never duplicate it. A database partial unique index
  enforces at most one open request per user and type.
- **Auth-only, own account**: session authentication is required and the
  request always belongs to the signed-in user; the body carries nothing.
- **Rate limited**: repeated abuse beyond the per-account limit is answered
  `429` with a `Retry-After`, without touching the database.

## Fulfilment

Fulfilment is manual and deliberately not part of this repository: the
support side reads open `support_requests` rows, generates the export out of
band and sends it, then marks the row `fulfilled`.

## Alongside account deletion

The account-deletion preview reads the same table: an open data request is
flagged on the deletion confirmation so deleting the account does not strand
the ask. The deletion flow itself offers no download — anyone who wants a
copy of their data before the delete raises a request here instead.
