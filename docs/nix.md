# Nix

The flake provides the `teams-live` package, an overlay and a NixOS module
that runs teams-live as a hardened systemd service.

## Flake outputs

| Output | Content |
| --- | --- |
| `packages.<system>.teams-live` | The daemon (`teams-live`) and its health check (`teams-live-health`). |
| `packages.<system>.msteams-mcp` | The Teams client library teams-live uses. |
| `overlays.default` | Adds `teams-live` and `msteams-mcp` to `pkgs`. |
| `nixosModules.default` | The `services.teams-live` module, with the flake's package as default. |

## Module

```nix
{
  inputs.teams-live.url = "github:pschmitt/teams-live";

  outputs = { nixpkgs, teams-live, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        teams-live.nixosModules.default
        ./teams-live.nix
      ];
    };
  };
}
```

```nix
# teams-live.nix
{ config, ... }:
let
  secret = name: { _secret = config.sops.secrets.${name}.path; };
in
{
  services.teams-live = {
    enable = true;
    settings = {
      teams.credentials_file = config.sops.secrets."teams-live/credentials".path;
      browser_daemon = {
        url = "https://browser.example.com";
        profile = "msteams";
        secret_file = config.sops.secrets."browser-daemon/secret".path;
      };
      gitlab = {
        host = "git.example.com";
        group = "my-group";
        token_file = config.sops.secrets."teams-live/gitlab-token".path;
      };
      opsgenie.on_call_key = secret "opsgenie/on-call-key";
      conversations = [
        { id = "48:notes"; name = "Notes (Self)"; gitlab = true; }
        { id = secret "teams-live/team-chat"; name = "Team"; gitlab = true; }
      ];
    };
  };
}
```

The example uses [sops-nix](https://github.com/Mic92/sops-nix); any tool that
puts secrets into files works. Each secret file must be readable by the
service user (`teams-live` by default).

### Secrets

`settings` is written to a JSON file in the Nix store, which every user on
the host can read. Never put a secret value there. Two ways keep it out:

- **`*_file` keys** (`teams.credentials_file`, `gitlab.token_file`,
  `jira.token_file`, `confluence.token_file`, `home_assistant.token_file`,
  `browser_daemon.secret_file`) take a path, and teams-live reads the file.
- **`{ _secret = "/path"; }`** works for any other value. teams-live replaces
  the object with the trimmed contents of the file when it starts, and fails
  with the name of the key if the file cannot be read. Use it for API keys,
  and for identifiers you do not want in the store, such as conversation ids.

### Restarts

The service restarts when `settings` change, because the store path of the
config file changes. It does not notice when a secret file changes; let the
tool that writes the secret restart it, for example with sops-nix:

```nix
sops.secrets."opsgenie/on-call-key".restartUnits = [ "teams-live.service" ];
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `enable` | `false` | Run teams-live. |
| `package` | the flake's package | Package to run. |
| `settings` | `{ }` | Configuration, see below. |
| `configFile` | `null` | A complete JSON config file to use instead of `settings`. A file outside the store does not restart the service when it changes. |
| `dataDir` | `/var/lib/teams-live` | State, token caches and session data. |
| `user`, `group` | `teams-live` | Account the service runs as. The module creates it only with the default name. |
| `extraGroups` | `[ ]` | Supplementary groups, for example to read secret files. |
| `healthCheck` | read-only | Health check command for this service, see below. |

The options `credentialsFile`, `gitlabTokenFile`, `browserDaemonUrl`,
`browserDaemonProfile` and `browserDaemonSecretFile` are renamed to their
`settings` keys and print a warning.

### Health check

`services.teams-live.healthCheck` runs `teams-live-health` against this
service. It exits 0 while the service is healthy, starting or degraded, and
non-zero when the unit is down, `health.json` is missing or stale (older
than 90 s), or the service reports itself unhealthy. With monit:

```nix
services.monit.config = ''
  check program teams-live with path ${config.services.teams-live.healthCheck}
    if status > 0 for 2 cycles then exec "/run/current-system/sw/bin/systemctl restart teams-live"
'';
```

`teams-live-health --help` lists its options for use outside the module.

## Settings

All keys are optional. Defaults are in [`src/config.mjs`](../src/config.mjs).

| Key | Description |
| --- | --- |
| `teams.credentials_file` | Teams session state to start from. |
| `teams.reconnect_interval_seconds` | Wait before reconnecting to Trouter (5). |
| `teams.token_refresh_interval_minutes` | How often the token lifetime is checked (60). |
| `teams.registration_interval_minutes` | How often push registrations are renewed (15). |
| `teams.max_session_minutes` | Age after which the push session is replaced (60). |
| `teams.history_poll_interval_seconds` | Poll of the watched chats for missed pushes (120, 0 disables). |
| `teams.rich_messages` | Post the watcher messages as Adaptive Cards (false). See [Rich messages](#rich-messages). |
| `gitlab.approve.*` | Approve button of merge request cards: capability link (off). See [Approving from a card](#approving-from-a-card). |
| `teams.troll_user` | User MRI whose `/exec` gets a joke reply instead of the fake shell output. |
| `browser_daemon.url`, `.profile`, `.secret_file` | browser-daemon used to sign in to Teams again. |
| `gitlab.host`, `.group`, `.token_file` | GitLab instance, group for `/mrs`, API token. |
| `gitlab.poll_interval_seconds` | MR status poll (60). |
| `gitlab.history_limit`, `.history_max_age_minutes` | Messages scanned at startup. |
| `gitlab.max_watch_duration_seconds` | How long an MR is watched (7200). |
| `gitlab.notify.ci.{enable,on_failure,on_success}` | CI result messages. |
| `gitlab.notify.{rebase,approval_lost,merged,closed}` | Other MR messages. |
| `gitlab.webhook.{enable,port,host,path,url,secret_file,auto_setup}` | Receiver for GitLab events and the group hook that feeds it. See [GitLab webhook](#gitlab-webhook). |
| `gitlab.webhook.adopt_hooks` | Hand-made hooks this service may take over, `[{ id, url }]` (none). |
| `gitlab.webhook.accept_shared_secret` | Keep accepting the shared secret next to the per-hook tokens (false). |
| `jira.url`, `.token_file`, `.board_id` | Jira for `/sprint`, `/issue` and `/standup`. |
| `confluence.url`, `.token_file` | Confluence instance and API token for doc links and `/doc`. |
| `opsgenie.on_call_key`, `.support_key`, `.edge_key` | OpsGenie API keys for `/alerts` and `/oncall`. |
| `opsgenie.on_call_schedule_id`, `.support_schedule_id` | Schedules for `/oncall`. |
| `opsgenie.base_url`, `.web_base_url` | OpsGenie API and web URLs. |
| `home_assistant.url`, `.token_file` | Home Assistant with the HR WORKS integration, for `/whereis`. |
| `home_assistant.hrworks_batch_size` | Organizational units per HR WORKS request when prefetching the company (4). Keep each request under the proxy timeout. |
| `conversations` | Chats to watch: `{ id, name, gitlab }`. Default: the self chat `48:notes`. |

## GitLab webhook

With `gitlab.webhook.auto_setup` (default) and a secret, the service keeps one
group hook pointing at `gitlab.webhook.url`. It never trusts a name or a URL
to decide which hook is its own:

- Every hook it creates carries a marker in its description,
  `teams-live-owner:<owner> gen:<generation> v1`. The owner id is created once
  and kept in `webhook-reconcile.json` (0600) in the state directory. Hooks
  without the marker, or with another owner, are never changed or deleted. A
  hook that merely has the configured URL is not adopted either; a separate
  hook is created next to it.
- Every hook gets its own token, derived (HMAC) from the secret, the owner
  and the generation. The receiver accepts these tokens and nothing else
  once management is on. The token proves which generation delivered, not
  where the request came from. Neither the secret nor a token is logged or put
  in the state file, and the secret itself is not sent to GitLab for managed
  hooks.
- A new `url` (for example a hostname change) never edits the existing hook.
  It creates a replacement with its own generation and keeps the old hook. When
  the replacement has delivered an event with its own token, the old hook is
  re-read, compared (id, URL, marker) and deleted. Several hooks of this
  service during such a move are expected. Changing the secret is handled the
  same way.
- Nothing is deleted without a strong secret (at least 32 characters) and
  with a failed or partial hook listing. At most three hooks are deleted per
  run, a hook that changed since it was recorded is left alone, and the plan is
  written to the state file before each deletion. Without a strong secret hooks
  are only registered.
- The run happens at startup, every ten minutes and after a verified delivery.
  A sample delivery is requested from GitLab after creating a hook
  where the API allows it.

Taking over an existing hand-made hook: list it in
`gitlab.webhook.adopt_hooks` with its id and exact URL. It is read again and
must still have that URL and no marker. While such a hook is tracked, the
shared secret stays valid for it. Deploying management to a group that already
has a hook without listing it there means its deliveries are rejected (401)
and a new hook is created.

## Rich messages

By default the watcher posts regular markdown messages. With
`teams.rich_messages = true` it posts an Adaptive Card per entity instead, laid
out for what the entity is:

| Entity | Card |
| --- | --- |
| GitLab merge request (open, merged, closed, rebase required, rebased) | Title, state colour, approval, auto-merge, pipeline, rebase (only when required), target branch, Jira key, links |
| GitLab job and pipeline | Status colour, stage, ref, duration, failure reason, linked merge request |
| Jira issue | Summary, type, status, priority, assignee |
| OpsGenie alert | Message, priority badge (P1 red to P5 subdued), OPEN / ACK'D / CLOSED badge, owner |
| Confluence page | Title, space, author |

Command replies use the same gate. Commands that return structured data answer
with a card built from the very same markdown as the regular reply, so no fact,
link, count or truncation note is lost:

| Command | Card |
| --- | --- |
| `/mrs` | List card, one row per merge request with approval, auto-merge, draft and rebase/conflict badges |
| `/alerts`, `/oncall` | OpsGenie list and on-call card |
| `/sprint`, `/issue`, `/doc` | Jira sprint, issue and Confluence page cards |
| `/status <MR>` | Merge request card (open, merged or closed) |
| `/ci` | Pipeline card |
| `/whois` (`/who`) | Contact card, or a search-results list |
| `/whereis` (`/where`) | Availability card, or a search-results list |
| `/meetings`, `/standup` | Meetings and standup summary cards |

Not carded, on purpose: help, errors, acknowledgements, admin notices, `/exec`,
`/random`, `/weather`, `/flip`, `/retry`, and `/status` without arguments
(runtime status). Mentions keep their regular behaviour: a reply that mentions
someone (for example `/whois` for a contact with a Teams identity) is sent as the
regular plain message so the notification is unchanged, and the card is used when
nobody is mentioned. A card larger than the Teams payload limit falls back to the
full regular message.

Merge request cards always show the approval and auto-merge lines on open
merge requests, including "Not approved yet" and "Disabled", and say "Unknown
(not retrieved)" when GitLab could not be asked. The rebase line appears only
while a rebase is required (with the reason, merge conflicts when known, and the
GitLab status) and disappears once it is resolved. Merged and closed cards keep
the last known approval, auto-merge and rebase state.

Merge request cards show the size of the change as `+added -removed lines`
(green and red, with textual signs). The totals come from GitLab's GraphQL
`diffStatsSummary` for the exact head commit (the REST `changes_count` counts
files, not lines, and is not used). They are looked up once per head commit with
a short timeout, cached, and reused by in-place refreshes of the same commit.
When GitLab does not report usable numbers (older instance, error, timeout) the
row is simply left out; totals are never guessed or summed from partial data.

OpsGenie priority and status badges are textual (P1, OPEN, ACK'D, CLOSED) and use
the closest Teams card colours (good, attention, warning, accent); Teams does
not allow arbitrary colours, so the shades are approximate, not pixel-exact.

Every card starts with a compact header: the logo of the service (GitLab, Jira,
OpsGenie or Confluence, embedded as a small PNG, no image fetch) and a label
such as "GitLab · Merge request" or "Jira · Bug". Below it come the title, a
one-line subtitle and a few facts. Navigation is done with inline links, not
buttons: the title links to the entity, and cross references inside the card are
linked too (the pipeline and Jira key of a merge request, and the pipeline and
merge request of a job or pipeline). A link is only added for a valid http(s)
URL; without one the text stays plain, and brackets in titles are escaped so
they cannot break the link. Cards carry no bottom buttons, except the optional
"Approve..." button of a merge request card (see
[Approving from a card](#approving-from-a-card)).

Status lines keep the emojis of the regular messages: approval, pipeline,
rebase, auto-merge, merged and closed on merge requests, and the CI status on
job and pipeline cards. The CI emojis come from one shared mapping.

Replies, in-place updates and edits of the author's message behave as with
regular messages: channel replies stay in the thread, chat replies quote the
original, and the card replaces the previous message content. The regular text
is kept as the card's `fallbackText` (used for notifications and previews). If
Teams rejects a card, the message is sent again as regular text. A message
whose text mentions someone is always sent as regular text, because a card
cannot carry the mention. Updating a card message with regular text clears the
card.

```nix
services.teams-live.settings.teams.rich_messages = true;
```

Cards use the wire format of the Teams client: the message HTML holds an
`InputExtension` span with a `cardClientId` (a UUID without hyphens) and the
`cards` message property holds `[{cardClientId, content, contentType}]` with the
Adaptive Card as `content`. Note that the Teams chat service reports success
even for a payload it does not render (the message shows as a blank bubble), so
try it in your own notes chat first:

```bash
node src/smoke-rich.mjs <your-notes-conversation-id> --mode both --kind mr,jira   # --mode regular|rich sends only that kind of message and reply
node src/smoke-rich.mjs <conversation-id> --dry-run   # print the payloads only
```

The script uses generic fixture data and refuses channel conversations.

### Approving from a card

With `teams.rich_messages` on and the approval flow enabled, an open merge
request card gets an "Approve..." button. The button opens a confirmation page;
it never approves by itself.

The link is a capability: **anyone who has the link can approve that one merge
request, using the service's configured GitLab account** (not as themselves;
the page says so). There is no sign-in, no proxy authentication and no shared
secret. Forwarding the card forwards the ability to approve, so treat the link
like the approval it stands for.

How the link is built:

- The token is 256 random bits. The server stores only its SHA-256 and the
  merge request, head commit and expiry (`approve-links.json` in the state
  directory, mode 0600, bounded). A link is bound to one merge request and the
  exact head commit shown on the card.
- The token sits in the URL fragment (`https://<host>/approve/#<token>`), so
  it is not sent to the server, proxies or access logs, and not in a Referer.
  The page is static (no token, no GitLab call, no third-party resources, a
  CSP that pins its one inline script). The script clears the fragment from the
  address bar and POSTs the token, same origin, to `/session`. The server
  answers with a short-lived (15 minutes, never longer than the link)
  `HttpOnly`, `SameSite=Strict` (and `Secure` on https) cookie, and the browser
  continues to a clean `/confirm` URL.
- Opening the link, and any scan, prefetch, preview or HEAD request, neither
  approves nor uses the link up. `/confirm` (GET) only shows the current state;
  the approval is an explicit confirmation POST that needs the session cookie,
  a CSRF token bound to that session and link, and an `Origin` (or `Referer`)
  equal to the configured `base_url` origin (fail closed).
- A link is used up only after GitLab confirms the approval; a replay or a
  concurrent request never approves twice. After an unclear network or server
  error the service looks at its own approval before saying what happened, and
  does not use the link up unless the approval is confirmed.
- The approval is sent with the head SHA, and the page checks that the merge
  request is open, not a draft, not yet approved by the service's account and
  that GitLab lets it approve. A merge request that gained commits, was closed
  or merged invalidates the link. A pending pipeline or merge status does not
  block it.
- Links expire after `link_ttl_seconds` (default 24 hours, bounded to 60 s to
  7 days). The same open link is shown again when the card is refreshed; after
  a restart a new link is minted and older ones stay valid until they expire.
- Responses are `Cache-Control: no-store` with `nosniff`, `X-Frame-Options:
  DENY` and a restrictive CSP. The `Referrer-Policy` is `same-origin` rather
  than `no-referrer`: with `no-referrer` browsers send `Origin: null` on the
  form POST, which the Origin check has to reject. No secret is in any served
  URL. Repeated invalid tokens are throttled. The token is never logged.

The page is served by a separate listener, not by the webhook server. It binds
to loopback. Put a reverse proxy in front that forwards the `base_url` path
prefix (`/`, `/session`, `/confirm`) to it, over https, **without** an
authentication layer. The proxy may keep the path prefix or strip it.

| Key | Description |
| --- | --- |
| `gitlab.approve.enable` | Start the flow (false). |
| `gitlab.approve.host`, `.port` | Listener, loopback only (127.0.0.1, 3006). |
| `gitlab.approve.base_url` | Public https URL of the page, for example `https://<host>/approve`; no query or fragment. It is also the allowed Origin of the POSTs. Plain http is accepted only for loopback. |
| `gitlab.approve.link_ttl_seconds` | Lifetime of a link (86400). |

The environment fallbacks are `TEAMS_GITLAB_APPROVE_*` (`ENABLE`, `HOST`,
`PORT`, `BASE_URL`, `LINK_TTL_SECONDS`). The former `owner_users`,
`owner_users_file`, `user_header`, `proxy_secret`, `proxy_secret_file` and
`proxy_secret_header` keys are no longer used; a configuration that still sets
them gets a warning and they are ignored.

The button is hidden once the merge request is approved or when the head commit
is unknown. After an approval the card of the merge request is re-checked; the
page says whether that refresh ran, failed or had no card to update.
