---
title: Subprocessors
route: /subprocessors
version: "[VERSION]"
effective: "[EFFECTIVE DATE]"
---

# HITLy™ Cloud Subprocessors

Metaspan Ltd uses the third parties below to process Customer Personal Data for HITLy Cloud. This list is Annex 3 of our Data Processing Agreement (https://hitly.net/dpa).

**Change notice:** we will give at least **30 days' notice** before we add or replace a subprocessor. Notice is posted on this page and emailed to workspace owners who subscribe. To subscribe, email support@hitly.net with "Subprocessor updates" in the subject line. You may object on reasonable data protection grounds within those 30 days, as set out in section 6 of the DPA.

Last updated: [EFFECTIVE DATE]

## Subprocessors (active)

| Subprocessor | Purpose | Data processed | Location | Transfer safeguard |
|---|---|---|---|---|
| Resend, Inc. | Transactional email: invites, password reset, email change, "decision needed" notices, and security and account notices (password changed, account deleted, API key review) | Recipient email address; message content (for example the action name and a link to the item) | United States | EU–US Data Privacy Framework and UK Extension; EU SCCs and UK Addendum in Resend's DPA |
| 650 Industries, Inc. (Expo) | Mobile push notification delivery (Expo Push Service) | Push tokens; notification title and text (action, project, expiry); item identifiers | United States | EU–US Data Privacy Framework and UK Extension; EU SCCs (Module 2) in Expo's terms |
| Google LLC (Firebase Cloud Messaging) | Delivering push notifications to Android devices | Device token; notification content passed on by Expo | United States and global | EU–US Data Privacy Framework and UK Extension; Google's data processing terms |
| Apple Inc. (Apple Push Notification service) | Delivering push notifications to iOS devices | Device push token; notification content passed on by Expo | United States and global | EU SCCs and UK Addendum under Apple's developer terms |
| Google LLC (Google Workspace) | The support@hitly.net mailbox, which feeds our helpdesk | Emails you send to support, including attachments and any Customer Data you include | United States and global | EU–US Data Privacy Framework and UK Extension; Google Workspace data processing terms |

## Subprocessors that start when billing launches

| Subprocessor | Purpose | Data processed | Location | Transfer safeguard |
|---|---|---|---|---|
| Stripe, LLC and its affiliates | When billing launches: payment processing, subscriptions, invoices and tax for paid plans. Not yet active on HITLy Cloud; no customer data is sent to Stripe | Billing contact, company details, payment method (held by Stripe), invoices | United States and other Stripe locations | Stripe, LLC: EU–US Data Privacy Framework and UK Extension (UK–US Data Bridge); other Stripe entities: EU SCCs and UK Addendum in Stripe's DPA |

**AI-assisted support (when launched).** AI-assisted support is not built yet, and no AI model provider processes support emails today. If we use a third-party model provider when it launches, we will add it to this list with 30 days' notice before it processes customer data.

We will give 30 days' notice on this page and by email to workspace owners who subscribe before Stripe, or any third-party AI support model provider, starts processing customer data.

## Self-hosted by Metaspan (no third party)

These run on servers owned and operated by Metaspan Ltd in a UK data centre (High Wycombe). This covers HITLy Cloud, the support system and the backup host. HITLy Cloud backups are also copied to an off-site backup in the UK operated by Metaspan. The data-centre provider supplies space, power and network only and has no logical access to data and does not process data on our behalf. No third party processes Customer Personal Data through them.

| Component | Purpose |
|---|---|
| Application hosting and database | Runs HITLy Cloud, the API and the MCP server. The database runs on the same UK servers |
| Backups | HITLy Cloud: daily copy to separate Metaspan-owned servers in the UK. HITLy Cloud backups are also copied to an off-site backup in the UK operated by Metaspan. Live data is deleted at once; backup copies roll off within up to 5 months. Backups are kept secure and are not used for anything else. If we ever restore from a backup, we re-apply account deletions made since that backup before the service resumes. WAL-G and PBS backups are encrypted. Pre-release database copies: deleted from the server within 30 days; copies inside backups roll off with the backups, within up to 5 months. Support system: we may keep backups for up to 12 months; they will include a UK off-site backup |
| Better Auth (open-source library) | Sign-in, sessions, passkeys and MFA, stored in our own database |
| Plausible Analytics (self-hosted) | Cookieless, aggregate website and app analytics |
| Zammad helpdesk (self-hosted) | Handles emails sent to support@hitly.net |

## Vendors that are not subprocessors

These vendors provide infrastructure or tools, but they do not process Customer Personal Data:

| Vendor | Role |
|---|---|
| GitHub, Inc. | Hosts source code and runs CI. Holds no Customer Data |
| GoDaddy | Domain registrar and DNS for hitly.net. Sees DNS lookups only |
| Let's Encrypt (Internet Security Research Group) | Issues TLS certificates. Sees public hostnames only |

## Not used

HITLy Cloud does not use any third-party AI or large language model provider for workspace content. It uses no content delivery network, no third-party error monitoring or analytics service, and no third-party backup storage.

Customer-configured destinations, such as evidence sinks and OpenTelemetry exporters, are chosen and controlled by the Customer, and are not Metaspan subprocessors.
