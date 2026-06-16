# AWS Provisioning — Transmission Store

How to provision the AWS resources the store sidecar writes to: one S3 bucket,
one DynamoDB table, one SQS queue, plus the IAM permissions the relay needs.
Runbook for the `slice/store` work; pairs with `architecture/transmission-store-sidecar.md`
(design) and `relay/.env.example` (config).

> Until these exist and the env vars are set, the relay runs the **no-op store**
> (default): it persists nothing, calls no AWS, and the talking channel works
> exactly the same. Provisioning is what flips persistence on.

## Region

Provision in the **same region as the EC2 relay** (`ap-south-1` / Mumbai — see
`architecture/ec2-relay-ops.md`) to avoid cross-region data-transfer cost and
latency. Set `AWS_REGION` to match. The examples below use `ap-south-1`; the
store code defaults to `us-east-1` if `AWS_REGION` is unset, so don't leave it
unset.

```bash
export AWS_REGION=ap-south-1
export MIRA_HANDLE=harshit          # something globally-unique for the bucket name
```

## What the slice writes (and the env var each maps to)

| Resource | Purpose | Env var |
|---|---|---|
| S3 bucket | transcoded `audio/mp4` bytes | `MIRA_S3_BUCKET` |
| DynamoDB table | event operational memory (TRANSMISSION items) | `MIRA_DDB_TABLE` |
| SQS queue | transcription jobs for the STT pipeline | `MIRA_SQS_QUEUE_URL` |

## 0. Verify the CLI is configured

```bash
aws sts get-caller-identity        # expect your Account ID as JSON
```

## 1. S3 bucket (audio)

The relay writes server-side via `PutObject`, so **no CORS is required for this
slice** (CORS is only needed later if a browser reads audio directly).

```bash
aws s3api create-bucket \
  --bucket "mira-transmissions-$MIRA_HANDLE" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"

# Block all public access (audio is private operational data)
aws s3api put-public-access-block \
  --bucket "mira-transmissions-$MIRA_HANDLE" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Optional but recommended for the AWS budget — expire audio after 30 days so it
doesn't accumulate cost (key prefix is `<eventId>/<channelId>/<date>/...`, so a
whole-bucket rule is fine):

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket "mira-transmissions-$MIRA_HANDLE" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-audio-30d",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": 30}
    }]
  }'
```

→ `MIRA_S3_BUCKET=mira-transmissions-$MIRA_HANDLE`

## 2. DynamoDB table (event operational memory)

Single table, on-demand billing (no idle cost). The key schema must match the
item the code writes: partition key `pk` (e.g. `EVENT#event123`), sort key `sk`
(e.g. `TX#<endedAt>#<id>`). Both are strings; no other attributes are declared
at create time (DynamoDB is schemaless beyond the keys).

```bash
aws dynamodb create-table \
  --table-name mira-events \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "$AWS_REGION"

aws dynamodb wait table-exists --table-name mira-events --region "$AWS_REGION"
```

→ `MIRA_DDB_TABLE=mira-events`

**Do not create GSIs yet.** The slice's only access pattern (query `pk =
EVENT#<id>`, sort by `sk`) needs none. Operator-history (`GSI1PK = CLIENT#`) and
channel-replay (`GSI2PK = CHANNEL#`) indexes are added only when those queries
are actually built — adding a GSI later is an online operation.

## 3. SQS queue (transcription jobs)

Standard queue. Optional but recommended: a dead-letter queue so a transmission
that repeatedly fails transcription doesn't loop forever.

```bash
# (optional) dead-letter queue
DLQ_URL=$(aws sqs create-queue --queue-name mira-transcription-dlq \
  --region "$AWS_REGION" --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --region "$AWS_REGION" \
  --query 'Attributes.QueueArn' --output text)

# main queue (redrive to the DLQ after 5 failed receives)
aws sqs create-queue \
  --queue-name mira-transcription \
  --region "$AWS_REGION" \
  --attributes "{
    \"VisibilityTimeout\": \"120\",
    \"MessageRetentionPeriod\": \"345600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"
```

The create-queue call prints the `QueueUrl`.

→ `MIRA_SQS_QUEUE_URL=<that QueueUrl>`

`VisibilityTimeout` (120s here) should comfortably exceed how long the future
STT worker takes per clip. SQS is not consumed in this slice — only written —
so this is forward-provisioning for the STT pipeline.

## 4. IAM — what the relay is allowed to do

This slice's write path needs exactly three actions, scoped to the three
resources. Replace `ACCOUNT_ID` and the names if you changed them.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StoreAudio",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::mira-transmissions-HANDLE/*"
    },
    {
      "Sid": "StoreMetadata",
      "Effect": "Allow",
      "Action": "dynamodb:PutItem",
      "Resource": "arn:aws:dynamodb:ap-south-1:ACCOUNT_ID:table/mira-events"
    },
    {
      "Sid": "EnqueueTranscription",
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:ap-south-1:ACCOUNT_ID:mira-transcription"
    }
  ]
}
```

**On the EC2 relay (recommended):** attach this as an IAM policy to an instance
role / instance profile on the relay box. Then the default AWS SDK provider
chain picks up credentials automatically — **no `AWS_ACCESS_KEY_ID` on the
instance**, nothing secret in env or repo.

**For local testing against real AWS:** create a dedicated IAM user with the
same policy and export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in your
shell (never commit them — `.env*` is gitignored). Better for day-to-day dev:
just use the no-op store (set nothing) and don't touch AWS at all.

> The future STT worker is a *separate* principal and needs different
> permissions (`sqs:ReceiveMessage`/`DeleteMessage`, `s3:GetObject`,
> `dynamodb:PutItem` for the transcript). Do not grant those to the relay.

## 5. Wire the relay

On the relay host (`.env.local` / PM2 env / instance env — never commit):

```bash
MIRA_S3_BUCKET=mira-transmissions-harshit
MIRA_DDB_TABLE=mira-events
MIRA_SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/ACCOUNT_ID/mira-transcription
MIRA_RELAY_ID=relay-mumbai-1
AWS_REGION=ap-south-1
# credentials: omit if using an EC2 instance role
```

Restart the relay (`pm2 restart mira-relay`). On the next transmission the logs
show `persisted transmission <id>` instead of nothing. `MIRA_SQS_QUEUE_URL` is
optional — leave it unset to persist to S3 + DynamoDB without enqueuing STT.

## 6. Smoke-test the resources exist

```bash
aws s3api head-bucket --bucket "mira-transmissions-$MIRA_HANDLE" --region "$AWS_REGION" && echo "bucket OK"
aws dynamodb describe-table --table-name mira-events --region "$AWS_REGION" --query 'Table.TableStatus'   # "ACTIVE"
aws sqs get-queue-url --queue-name mira-transcription --region "$AWS_REGION"
```

After a real transmission:

```bash
aws s3 ls "s3://mira-transmissions-$MIRA_HANDLE/" --recursive
aws dynamodb query --table-name mira-events --region "$AWS_REGION" \
  --key-condition-expression 'pk = :e' \
  --expression-attribute-values '{":e":{"S":"EVENT#default"}}'
```

## Cost posture

- DynamoDB `PAY_PER_REQUEST` and SQS: no idle cost; you pay per request,
  proportional to transmissions.
- S3: pay for stored bytes; the 30-day lifecycle rule caps accumulation.
- One `PutObject` + one `PutItem` + one `SendMessage` per transmission. No
  polling, no streams, no background sweeps.
- Keep everything in one region (`ap-south-1`) to avoid data-transfer charges.
- Mind the $200 AWS budget + alerts — these resources are cheap at hackathon
  volume, but the lifecycle rule and on-demand billing are the guardrails.

## Teardown

```bash
aws s3 rb "s3://mira-transmissions-$MIRA_HANDLE" --force --region "$AWS_REGION"
aws dynamodb delete-table --table-name mira-events --region "$AWS_REGION"
aws sqs delete-queue --queue-url "$MIRA_SQS_QUEUE_URL" --region "$AWS_REGION"
# plus the DLQ if you created one
```
