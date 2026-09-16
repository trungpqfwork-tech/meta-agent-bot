# Quick Tunnel test deployment

A Cloudflare Quick Tunnel gives a temporary HTTPS hostname without owning a domain.
It must point at the webhook-only edge, NOT directly at the OpenClaw Gateway.

## Components

- `src/edge.mjs /absolute/runtime/edge.json` binds loopback and allows only the exact
  configured webhook path. GET validates the local Verify Token. POST requires a
  valid Meta HMAC signature and forwards unchanged bytes to the fixed local route.
- Cloudflared points to the edge port, not the Gateway or operator-console port.
- `backendEnabled:false` is bootstrap mode: verification works but POST returns 503.
  Do not describe bootstrap as a working message integration. Set true only after
  the plugin is running and local verification succeeds.

Example edge.json (no secret values):

```json
{
  "port": 18892,
  "webhookPath": "/webhooks/page-cskh",
  "upstream": "http://127.0.0.1:18789/webhooks/page-cskh",
  "envFile": "/absolute/runtime/.env",
  "backendEnabled": false
}
```

Example tunnel command:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:18892 --protocol http2
```

Inspect existing services before installing user units. The deployment on this
machine uses `page-cskh-edge.service` and `page-cskh-quick-tunnel.service` under the
user service manager. Check with `systemctl --user status SERVICE`; stop with
`systemctl --user stop SERVICE`. No Gateway service replacement is required.

## Verification

From outside localhost, confirm valid GET challenge returns exact text and 200;
wrong token returns 403; `/`, `/status` and other Gateway routes return 404.
After enabling the backend, use a signed empty Page event to test transport without
inventing a customer, sending a reply or invoking a paid model.
Never put Verify Token in copied logs or chat. Do not enable request-body capture.

## Important limits

Quick Tunnel is for tests, has no production SLA, and hostname can change when the
tunnel process restarts. Update `publicWebhookUrl` and Meta Callback URL after a
change; a service manager restart does not preserve a Quick Tunnel hostname.
The user services run while the user's service manager is active; reboot/login,
sleep, power and Internet availability still affect uptime.
No automatic paid subscription, domain purchase, or Meta app mutation is performed.
