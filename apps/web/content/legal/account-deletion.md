---
title: Account deletion and data requests
route: /account-deletion
version: "[VERSION]"
effective: "[EFFECTIVE DATE]"
---

# Delete your HITLy™ account, or make a data request

This page is for users of **HITLy Cloud** and the **HITLy Android and iOS apps**, provided by **Metaspan Ltd**.

## Delete your account yourself

You can delete your HITLy account at any time in the web app at https://cloud.hitly.net.

1. Sign in at https://cloud.hitly.net.
2. Open the user menu and choose **Account**.
3. Under **Delete account**, you can first choose **Export my data** to download a copy (see below).
4. Choose **Continue to deletion**, then confirm with your password or passkey.
5. Type `DELETE`, then choose **Delete my account permanently**.

Deletion is immediate and permanent; there is no grace period. We email you to confirm it.

**Before you start:**
- **End any paid plan first.** You can't delete your account while a workspace you own has an active Pro, Team or Enterprise subscription. Cancel it under **Billing**. Cancellation takes effect at the end of the period you have paid for, and you can delete your account after that. To close sooner, email support@hitly.net.
- **Workspaces you share.** If you are the only owner of a workspace that has other members, you can't delete your account until someone else is made owner. Email support@hitly.net to arrange this. Alternatively, remove the other members first: a member who is the only admin of a project cannot be removed until another project admin is in place, and workspace owners cannot be removed through the member-removal action.

## Export my data

Before you delete your account, the Account page lets you download your profile and the contents of any workspace that will be deleted with it. Choose **Export my data** to get a JSON file. Project credentials are redacted, and API keys are exported as metadata only. Data in workspaces you share with others stays with those workspaces, so it isn't included.

For a full copy of your data, or to use any other right, make a Data request (below).

## What we delete, and what we keep

When you delete your account, we delete these immediately from HITLy Cloud's live systems:
- your profile, sign-in methods (password, passkeys, MFA), sessions, devices and push tokens;
- your workspace memberships, pending email-change and verification links, and invitations sent to your address;
- the workspaces where you are the only member, with everything in them (projects, API keys, approvals and decisions).

**Workspaces you share with others:**
- Your membership is removed.
- API keys stay with the workspace, and its owners and admins are emailed to review them.
- Your past decisions, including their comment text, stay in the workspace's records, with your name replaced by "Deleted user" and device fields removed.

**What we keep, and for how long:**
- **HITLy Cloud backups:** live data is deleted at once. HITLy Cloud backup copies roll off within up to 5 months. Until backups roll off, they are kept secure and are not used for anything else.
- **Pre-release database copies:** before each software release, we take a copy of the database. These copies are deleted from the server within 30 days; any copies inside HITLy Cloud backups roll off with the backups, within up to 5 months.
- **Security logs:** account security events (MFA changes, recovery-code use and lockouts, passkeys added or removed, email verified, account deleted) are linked to your account while it exists. After deletion, they are kept for 90 days in pseudonymised form (your ID and email replaced by keyed hashes, and your IP address shortened), then deleted.
- **Billing and tax records**, where paid plans were used: kept for 6 years, as UK law requires.
- **Support emails:** kept for 2 years after the request is closed. We may keep support backups for up to 12 months, then they are deleted. They will include a UK off-site backup.

If we ever restore from a backup, we re-apply account deletions made since that backup before the service resumes.

## Can't sign in, or no longer have the app?

You don't need the app. Email **support@hitly.net** from the email address on your account, with the subject "Delete my account". We will check that the request comes from the account holder, then delete the account. If a workspace you own still has a paid plan, we will help you end it first.

## Make a Data request (access, copy, correction and other rights)

1. Email **support@hitly.net** with the subject "Data request".
2. Tell us what you want: access, a copy, correction, restriction, objection or portability.
3. We may ask you to confirm your identity.

Our support team responds within **one month**. For complex or numerous requests, we can extend that by up to two further months, as the law allows. If we do, we will tell you why within the first month. Any pause or change to the time limit applies only where the law allows.

If your request is about content in a workspace your organisation controls, we will refer you to that organisation, which is the controller, and help it respond.

See our Privacy Notice for more: https://hitly.net/privacy
