# EC2 Relay — Operations

Instance details (instance ID, Elastic IP, allocation ID) are in `.env.local` — never commit them.

## Connection info

| Key | Value |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Type | t3.micro |
| DNS | `mira-relay.theharshitsingh.com` |
| Relay URL | `wss://mira-relay.theharshitsingh.com` |
| SSH key | `~/.ssh/mira-relay-key.pem` |

## Start / stop

```bash
# Load from .env.local first
source .env.local

# Start
aws ec2 start-instances --region ap-south-1 --instance-ids $EC2_INSTANCE_ID

# Wait until running (~30s)
aws ec2 wait instance-running --region ap-south-1 --instance-ids $EC2_INSTANCE_ID

# Stop (saves cost — only EBS ~$0.08/month while stopped)
aws ec2 stop-instances --region ap-south-1 --instance-ids $EC2_INSTANCE_ID
```

## Switch .env.local between local and EC2

```bash
# Local dev (default)
NEXT_PUBLIC_RELAY_URL=ws://192.168.88.7:8080

# EC2 (uncomment this, comment the line above)
# NEXT_PUBLIC_RELAY_URL=wss://mira-relay.theharshitsingh.com
```

Restart `npm run dev` after changing `.env.local`.

## SSH in

```bash
ssh -i ~/.ssh/mira-relay-key.pem ec2-user@mira-relay.theharshitsingh.com
```

## Relay process (PM2)

```bash
# Status
pm2 status

# Logs (live)
pm2 logs mira-relay

# Restart after deploying new server.js
pm2 restart mira-relay

# Stop / start process (not the instance)
pm2 stop mira-relay
pm2 start mira-relay
```

## Deploy updated relay code

```bash
scp -i ~/.ssh/mira-relay-key.pem \
  relay/server.js relay/package.json relay/package-lock.json \
  ec2-user@mira-relay.theharshitsingh.com:~/mira-relay/

ssh -i ~/.ssh/mira-relay-key.pem ec2-user@mira-relay.theharshitsingh.com \
  "cd ~/mira-relay && npm ci --omit=dev && pm2 restart mira-relay"
```

## What runs on the instance

- **PM2** manages `~/mira-relay/start.js` (entry point that calls `createRelay(8080)`)
- **Nginx** terminates TLS and proxies `wss://` to `ws://localhost:8080`
- **Certbot** auto-renews the Let's Encrypt cert (timer enabled)
- **FFmpeg** static binary at `/usr/local/bin/ffmpeg` — used by relay to transcode WebM to MP4

PM2 and Nginx both start automatically on instance reboot (systemd units registered).

## Verify relay is healthy

```bash
# Should print HTTP 200 or 101 (WebSocket upgrade)
curl -si https://mira-relay.theharshitsingh.com | head -2

# Quick WebSocket smoke test (needs wscat: npm i -g wscat)
wscat -c wss://mira-relay.theharshitsingh.com
```
