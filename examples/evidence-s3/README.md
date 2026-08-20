# S3 Evidence Storage with Garage

See [S3 evidence](/docs/s3) for configuration, production settings, and fail-closed behavior.

This example demonstrates using an S3-compatible storage backend for HITLy evidence events. It uses [Garage](https://garagehq.deuxfleurs.fr/), a lightweight, open-source, S3-compatible object storage server designed for self-hosting and geo-distributed deployments.

Garage is ideal for local development and simulates production S3 environments (AWS S3, Cloudflare R2, on-premises Ceph/Cloudian) without requiring cloud credentials.

## Purpose

This example shows how to:

1. Configure HITLy to store evidence events in S3-compatible storage
2. Run a local S3-compatible server (Garage) via Docker Compose
3. Create buckets and manage credentials
4. Configure a HITLy project to use the S3 evidence sink

In production, replace the Garage endpoint with AWS S3 (with versioning and Block Public Access), Cloudflare R2, or your on-premises S3-compatible storage (Ceph, Cloudian).

## Requirements

- Docker and Docker Compose
- Running HITLy instance (see main repo README)
- `aws` CLI (optional, for bucket management)

## Setup

### 1. Start Garage

```bash
docker compose up -d
```

Garage S3 API will be available at `http://127.0.0.1:3902`.

### 2. Create a Garage Key and Bucket

Garage requires explicit setup via its admin API. You can use the `garage` CLI inside the container or the admin API directly.

**Using the `garage` CLI:**

```bash
# Create a key pair
docker compose exec garage garage key new hitly-evidence
# Output:
# Key:           GK...
# Secret:        ...

# Save the Key ID (GK...) and Secret Access Key

# Create a bucket
docker compose exec garage garage bucket create evidence

# Allow the key to read/write the bucket
docker compose exec garage garage bucket allow --read --write evidence --key GK...
```

**Using the admin API:**

```bash
# Create a key
curl -X POST http://127.0.0.1:3904/v0/key \
  -H "Authorization: Bearer hitly-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "hitly-evidence"}'

# Create a bucket
curl -X POST http://127.0.0.1:3904/v0/bucket \
  -H "Authorization: Bearer hitly-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "evidence"}'

# Grant permissions (replace KEY_ID with the GK... from the key creation response)
curl -X POST http://127.0.0.1:3904/v0/bucket/evidence/allow \
  -H "Authorization: Bearer hitly-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"keyId": "KEY_ID", "permissions": {"read": true, "write": true}}'
```

### 3. Configure HITLy Project

In your HITLy project settings (Config tab), set:

- **Evidence Sink Type**: `S3`
- **S3 Endpoint**: `http://127.0.0.1:3902`
- **S3 Region**: `local`
- **S3 Bucket**: `evidence`
- **S3 Access Key ID**: `GK...` (from step 2)
- **S3 Secret Access Key**: (from step 2)
- **S3 Prefix**: (optional, e.g., `hitly/` to organize objects under a prefix)
- **Force Path Style**: Defaults to `true` for non-AWS endpoints (Garage, R2, on-premises S3). Automatically enabled when a custom endpoint is set.

Save the configuration.

### 4. Test the Evidence Sink

In your HITLy project config page, after saving the S3 configuration, click **Test Evidence Sink**. If successful, HITLy will POST a test evidence event to your Garage bucket.

Alternatively, trigger a real approval flow in your agent and check that evidence events are stored.

### 5. Verify Stored Objects

Using the `aws` CLI with custom endpoint:

```bash
aws --endpoint-url http://127.0.0.1:3902 \
    --region local \
    s3 ls s3://evidence/

# Example output:
# 2024-01-15 10:30:00     1234 evt_abc123.json

# Download an event
aws --endpoint-url http://127.0.0.1:3902 \
    --region local \
    s3 cp s3://evidence/evt_abc123.json -
```

Configure `aws` credentials if needed:

```bash
aws configure set aws_access_key_id GK...
aws configure set aws_secret_access_key ...
```

Or set environment variables:

```bash
export AWS_ACCESS_KEY_ID=GK...
export AWS_SECRET_ACCESS_KEY=...
```

## Production Considerations

For production use:

1. **AWS S3**:
   - Enable versioning: `aws s3api put-bucket-versioning --bucket evidence --versioning-configuration Status=Enabled`
   - Enable Block Public Access (default for new buckets)
   - Use a dedicated bucket for evidence (not mixed with application assets)
   - Endpoint: `https://s3.{region}.amazonaws.com` (or leave blank to use AWS SDK defaults)
   - Region: your AWS region (e.g., `eu-west-1`)
   - Use IAM credentials with PutObject permission

2. **Cloudflare R2**:
   - Endpoint: `https://{account-id}.r2.cloudflarestorage.com`
   - Region: `auto` (R2 uses a single global region)
   - Use R2 API tokens with Object Read & Write permissions
   - **Note**: R2 does not support Object Lock (community request only). Do not require Object Lock.

3. **On-Premises S3** (Ceph, Cloudian):
   - Endpoint: your S3-compatible service URL
   - Region: as configured by your deployment
   - Force Path Style: usually `true` for non-AWS S3

4. **Access Control**:
   - Use dedicated credentials with minimal permissions (PutObject only)
   - Store credentials in HITLy's encrypted config (project settings)
   - Rotate keys periodically

5. **Fail-Closed Behavior**:
   - HITLy already implements fail-closed for `decided` events: if the S3 sink returns 5xx or times out (>5s), HITLy will NOT resume the origin
   - Evidence is marked as pending; no retry/resume mechanism
   - Ensure your S3 service is reliable and monitored

6. **Store URI**:
   - HITLy records the S3 object URL as `store_uri` in the evidence receipt
   - The URL is `https://` (or your configured endpoint) + object key
   - This is NOT a `file://` URI; it is the S3 HTTP(S) URL
   - Users can fetch events via signed URLs or direct HTTPS GET if bucket policy allows

## Architecture

```
HITLy → (SigV4 PutObject) → Garage S3 API → Local disk
                           ↓
                        Evidence bucket
                           (evidence/evt_*.json)
```

Each evidence event is stored as a JSON file named `{event_id}.json`. The `store_uri` in the receipt is the HTTPS URL to that object.

## Files

- `docker-compose.yml` - Garage service definition
- `garage.toml` - Garage server configuration
- `README.md` - This file

## Troubleshooting

**Garage fails to start:**
- Check Docker logs: `docker compose logs garage`
- Ensure ports 3902 and 3903 are not in use

**PutObject fails with 403 Forbidden:**
- Verify the key has write permission on the bucket: `docker compose exec garage garage bucket info evidence`
- Check that the access key and secret are correct in HITLy project config

**PutObject fails with signature mismatch:**
- Ensure Force Path Style is `true` in HITLy config
- Verify the region in HITLy matches the Garage region (`local`)

**Test evidence sink returns 5xx:**
- Check Garage logs: `docker compose logs garage`
- Verify the bucket exists: `docker compose exec garage garage bucket list`

## References

- [Garage Documentation](https://garagehq.deuxfleurs.fr/documentation/)
- [AWS S3 API Compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
- [HITLy Evidence Envelope](/docs/envelope#evidence-storage)

## Stopping

```bash
docker compose down
```

To remove all data:

```bash
docker compose down -v
```
