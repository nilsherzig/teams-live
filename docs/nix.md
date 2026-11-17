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
| `gitlab.approve.*` | Approve button of merge request cards (off). See [Approving from a card](#approving-from-a-card). |
| `teams.troll_user` | User MRI whose `/exec` gets a joke reply instead of the fake shell output. |
| `browser_daemon.url`, `.profile`, `.secret_file` | browser-daemon used to sign in to Teams again. |
| `gitlab.host`, `.group`, `.token_file` | GitLab instance, group for `/mrs`, API token. |
| `gitlab.poll_interval_seconds` | MR status poll (60). |
| `gitlab.history_limit`, `.history_max_age_minutes` | Messages scanned at startup. |
| `gitlab.max_watch_duration_seconds` | How long an MR is watched (7200). |
| `gitlab.notify.ci.{enable,on_failure,on_success}` | CI result messages. |
| `gitlab.notify.{rebase,approval_lost,merged,closed}` | Other MR messages. |
| `jira.url`, `.token_file`, `.board_id` | Jira for `/sprint`, `/issue` and `/standup`. |
| `confluence.url`, `.token_file` | Confluence instance and API token for doc links and `/doc`. |
| `opsgenie.on_call_key`, `.support_key`, `.edge_key` | OpsGenie API keys for `/alerts` and `/oncall`. |
| `opsgenie.on_call_schedule_id`, `.support_schedule_id` | Schedules for `/oncall`. |
| `opsgenie.base_url`, `.web_base_url` | OpsGenie API and web URLs. |
| `home_assistant.url`, `.token_file` | Home Assistant with the HR WORKS integration, for `/whereis`. |
| `home_assistant.hrworks_batch_size` | Organizational units per HR WORKS request when prefetching the company (4). Keep each request under the proxy timeout. |
| `conversations` | Chats to watch: `{ id, name, gitlab }`. Default: the self chat `48:notes`. |

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
request card gets an "Approve..." button. It opens a confirmation page; it never
approves by itself. Opening the page (and any scan or preview of the link) only
reads. The approval is a POST with a CSRF token from that page.

The page is served by a separate listener, not by the webhook server. It binds
to loopback and is meant to sit behind a reverse proxy that authenticates the
user, injects the authenticated user name and a shared secret header, and
removes both headers from client requests. Requests without the secret are
rejected, so the user header is not trusted from anywhere else. Only the
configured owner users are allowed, and the approval is made with the service's
own GitLab token (the owner's identity): there is no per-user sign-in and nobody
else is authorized. Without owner users or without the proxy secret the flow
does not start (fail closed).

| Key | Description |
| --- | --- |
| `gitlab.approve.enable` | Start the flow (false). |
| `gitlab.approve.host`, `.port` | Listener, loopback only (127.0.0.1, 3006). |
| `gitlab.approve.base_url` | Public URL of the page, for example `https://<host>/approve`. It is also the allowed Origin of the POST. |
| `gitlab.approve.owner_users` | Authenticated user names that may approve (list; `TEAMS_GITLAB_APPROVE_OWNER_USERS` takes a comma separated string). `.owner_users_file` reads names from a file. |
| `gitlab.approve.user_header` | Header with the authenticated user (`Remote-User`). |
| `gitlab.approve.proxy_secret_file` | File with the secret the proxy sends (never inline; read at runtime). |
| `gitlab.approve.proxy_secret_header` | Header carrying it (`X-Teams-Live-Proxy-Secret`). |
| `gitlab.approve.link_ttl_seconds` | Lifetime of a link (86400). |

The environment fallbacks are `TEAMS_GITLAB_APPROVE_*` (`ENABLE`, `HOST`, `PORT`,
`BASE_URL`, `OWNER_USERS`, `OWNER_USERS_FILE`, `USER_HEADER`,
`PROXY_SECRET_FILE`, `PROXY_SECRET_HEADER`, `LINK_TTL_SECONDS`). The proxy may
keep the path prefix or strip it; both are accepted.

Links carry only an opaque random id. The merge request, its head commit and
the expiry are kept on the server (`approve-links.json` in the state directory,
mode 0600, bounded), so a link holds no credential and authorizes nothing by
itself. The approval is bound to the head commit shown on the card and is sent
with that SHA, so a merge request that gained commits is rejected as stale.
The page also checks that the merge request is open and not a draft, that
the service's GitLab account has not approved it yet, and that GitLab lets it
approve. A pending pipeline or merge status does not block it. A replayed or
concurrent request never approves twice, and after an unclear network or server
error the service looks at its own approval before saying what happened. The
button is hidden once the merge request is approved or when the head commit is
unknown. After an approval the card of the merge request is re-checked; the
page says whether that refresh ran, failed or had no card to update.
