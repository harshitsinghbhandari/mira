# Vercel Deployment

## Overview

The Next.js frontend is deployed on Vercel at `mira.theharshitsingh.com`. GitHub is connected so every push to `main` auto-deploys.

## Account

- **Team:** `harshitsinghbhandaris-projects`
- **Project:** `h01`
- **Dashboard:** `vercel.com/harshitsinghbhandaris-projects/h01`

## URLs

| | |
|---|---|
| Production | `https://mira.theharshitsingh.com` |
| Vercel alias | `https://h01-kappa.vercel.app` |
| Transmit test page | `https://mira.theharshitsingh.com/transmit` |

## Environment variables

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_RELAY_URL` | `wss://mira-relay.theharshitsingh.com` | Points at the EC2 relay. Set in Vercel dashboard under Settings > Environment Variables. Must be `wss://` (not `ws://`) because Vercel serves over HTTPS and browsers block mixed-content. |

## GitHub integration

Repo: `github.com/harshitsinghbhandari/mira`

Every push to `main` triggers an automatic production deployment. No manual `vercel --prod` needed.

To deploy manually (e.g. from a branch):
```bash
vercel --prod --yes
```

## How it was set up

1. Installed Vercel CLI: already available via Homebrew.
2. Logged in: `vercel login`
3. Deployed: `vercel --prod --yes` from the project root — Vercel auto-detected Next.js settings and uploaded the build.
4. Set env var: `echo "wss://..." | vercel env add NEXT_PUBLIC_RELAY_URL production`
5. Redeployed to pick up the env var: `vercel --prod --yes`
6. Added custom domain `mira.theharshitsingh.com` via the Vercel dashboard (Settings > Domains) and added the DNS record in the domain registrar.
7. Connected GitHub repo via the Vercel dashboard for auto-deploy on push.

### Account switch gotcha

The first deploy landed on a wrong Vercel account. To move it:
```bash
vercel logout
vercel login        # log into the correct account
rm -rf .vercel      # unlinks the project from the old account
vercel --prod --yes # fresh deploy on the new account
```

The `.vercel` directory is what ties a local project to a specific Vercel account and project. Deleting it resets the link.

## Redeploy checklist

If you need to redeploy manually:
1. Make sure you are logged into the right account: `vercel whoami`
2. Run `vercel --prod --yes` from the project root
3. Verify `NEXT_PUBLIC_RELAY_URL` is set: `vercel env ls`

## Local vs production relay

`NEXT_PUBLIC_RELAY_URL` is baked into the JS bundle at build time (it is a `NEXT_PUBLIC_` variable). Changing it requires a redeploy.

| Environment | Value in `.env.local` |
|---|---|
| Local dev | `ws://192.168.88.7:8080` |
| Production | set in Vercel dashboard, not in `.env.local` |

`.env.local` is gitignored and never deployed — Vercel uses only the variables configured in its dashboard.
