# SteamWorkshopSync

Keeps Steam Workshop subscriptions in sync across groups of Steam accounts.

Accounts pick up Workshop items on their own, for example when they join a community server that uses
custom maps or mods. SteamWorkshopSync notices those new subscriptions and copies them to every other
account in the same group. It also keeps them there, and removes them everywhere when you drop them
from your main account.

One small Docker container with a web interface. No browser runs inside it: it talks to Steam over HTTP
with each account's own session.

## How it works

- **Groups.** A group is a set of accounts plus the games (Steam app IDs) it syncs, for example
  "squad" for app 393380. Items for other games are ignored.
- **Discovery.** Any item a member subscribes to, for one of the group's games, is subscribed on every
  other member.
- **Desired state.** If a member loses a synced item, it is subscribed again. An item has to be missing
  from two reads in a row before anything happens, so one bad page never triggers changes. A member that
  is disabled or waiting for a sign-in loses a removed item when it comes back.
- **The main account** is in every group and receives every group's items.
  - When an item disappears from the main account, it is unsubscribed from every member of its group.
  - If many items disappear at once (more than the hold threshold in Settings, counted across all games
    and the last hour), nothing is removed until you approve it in the web interface. The same goes for an
    item Steam refuses the main account: its members only lose it once you approve.
  - Its password is never stored. It signs in from the web interface.
  - When the main account picks up a new item for a game that more than one group syncs, the web
    interface asks which group it belongs to.
- **Block list.** A blocked item is unsubscribed from every member, and again whenever it comes back.
  A removed (not blocked) item that comes back on any member is synced again.
- **Collections.** Adding a collection to a group adds all its items. The collection is read again every
  few hours, so items added to it later are synced too.
- **One-shot jobs.** Subscribe or unsubscribe items once on the accounts you pick. Nothing is kept in
  sync afterwards. Unsubscribing an item from every member of a group also takes it out of that group;
  cancelling the job puts it back.
- **Starting a group.** Nothing is changed when a group is created. Starting it first reads every
  member's subscriptions and shows a preview of the first sync (how many items, how many subscriptions),
  including anything you already added to the group. Steam is only touched after you confirm.

A web subscription only marks the item on the account. The game downloads it the next time the Steam
client runs for that account (a running client is told to start right away).

### Load on Steam

- A normal check costs one page per account and game: new subscriptions are listed first, and the
  total on that page shows whether anything disappeared. Only when the numbers do not add up is the whole
  list read (30 items per page). Every list is also read in full once a day.
- Writes are paced (2 s apart per account, at most 2400 per hour by default). If Steam throttles, writes
  pause and resume by themselves, also across a restart.
- Password logins are spaced out (15 s by default). While Steam throttles logins from your IP, logins
  wait 30 minutes, doubling up to 2 hours.

## Quick start

```yaml
# docker-compose.yml
services:
  steamworkshopsync:
    image: ghcr.io/mrachini/steamworkshopsync:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8080"
    environment:
      ADMIN_PASSWORD: pick-a-long-password
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

Open `http://localhost:8090` on that machine and sign in with `ADMIN_PASSWORD`. Without one, a password is
generated into `./data/admin-password.txt`. Example values such as `change-me` are ignored the same way.

1. **Accounts → Add account.** Enter the Steam *account name* (the login name). Accounts without Steam
   Guard get their password. For accounts with Steam Guard (usually your main account), leave the
   password empty and use **Sign in**: scan the QR code with the Steam mobile app, or enter the password
   and the Steam Guard code. Only the resulting sign-in (valid for about 7 months) is kept, and you are
   warned before it expires.
2. Tick **Main account** on your main account.
3. **Groups → New group.** Pick a name, the game's app ID and the member accounts.
4. **Start** the group, check the preview, then **Start syncing**.

Bulk import takes `name:password` per line, tab-separated `name<TAB>password<TAB>note`, or a JSON list.

## Configuration

Environment variables (everything else is set in the web interface):

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | generated into `/data/admin-password.txt` | Web interface admin password |
| `SECRET_KEY` | generated into `/data/secret.key` | Encrypts stored passwords and sessions. Keep it with the database. |
| `PORT` | `8080` | Port inside the container |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | empty | Certificate and key files, to serve HTTPS directly |
| `TRUST_PROXY` | empty | Address of a reverse proxy, e.g. `172.18.0.5`, so the login limiter sees real client IPs. Name the proxy itself: anything in a wide range could fake its address. |
| `PUBLIC_ORIGIN` | empty | The public URL, only needed behind a proxy that rewrites `Host` |

A view-only password can be set under Settings. Telegram notifications (new items, re-subscribed items,
removals, held removals, account problems) are optional and each kind can be switched off.

Everything the app stores lives in `/data`: one SQLite database and the encryption key. Back them up
together. Passwords, Steam sign-ins, session cookies and the Telegram token are encrypted (AES-256-GCM),
and the database can only be read by the user the app runs as, so back it up as root.

### HTTPS

The app speaks plain HTTP unless told otherwise, and Steam passwords pass through it. That is why the
compose file only opens the port on the machine itself. To reach it from anywhere else, use one of these:

- a reverse proxy that does HTTPS (Caddy, nginx, Traefik), with `TRUST_PROXY` set to its address
- `TLS_CERT_FILE` and `TLS_KEY_FILE`, pointing at a certificate mounted into the container
- an SSH tunnel or a VPN

Session cookies are marked `Secure` as soon as the app sees HTTPS.

## Development

Node.js 24, TypeScript, Fastify, SQLite (`node:sqlite`), no frontend framework.

```bash
npm ci
npm test
```

The tests run against an offline fake Steam (`test/fake-steam.mjs`) that serves the same page and API
shapes as the real one and blocks every outbound connection.
