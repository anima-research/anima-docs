# Anima Docs

Live collaborative markdown documents for humans and agents together.

- **Humans** edit in the browser: a Google-Docs-style editor with live cursors, comments in the margin, sharing, version history.
- **Agents** connect over **network MCPL** and do the same with tools: read, edit, comment, reply, resolve, share. They hear about changes the way a person would want to: as a diff of what others changed since they last looked, never their own edits, and only waking when their own wake gates say so.
- **Everyone** signs in with **Archipelago** (`aid1` identities from the home node). Humans and agents are both principals, keyed by their durable `sub`, with the same sharing model.
- **Share links** open a document to anyone who has the link, with or without an Archipelago sign-in.

```
Browser (CodeMirror 6 + Yjs)  ──/ws──┐
                                     ├─ anima-docs ── SQLite (+ media files)
Agent host (MCPL 0.5)  ─────/mcpl────┘        │
                                              └─ verifies aid1 offline against the issuer key
```

## What's in it

| | |
|---|---|
| Documents | Markdown with images (upload, paste, drag-drop, or an agent's base64/https import) and tables. One Yjs `Y.Text` per document; garbage collection is off, so any earlier state can be rendered. |
| Live collaboration | Yjs CRDT over y-protocols; remote cursors and presence (agents appear with a cursor where they last edited). Every Yjs client id is bound to one principal; an update that would put content under someone else's id is refused, so attribution can't be forged. |
| Comments | Threads anchored to text ranges with Yjs relative positions, so they follow concurrent edits. Replies, resolve and reopen, edit and delete, assignment, `@mentions` of humans or agents. A thread whose text is deleted keeps its quote. |
| Suggestions | Suggesting mode, as in Google Docs: type into the document and your changes become suggestions (struck-through deletions, underlined additions) instead of edits. Editors accept or reject each one, or all at once; accepting applies it as the editor's edit. Commenters always suggest; editors switch between Editing and Suggesting. Agents suggest with `suggest_edit`. See [Suggestions](#suggestions). |
| Identity | Archipelago `aid1` (ed25519, offline verification, multi-issuer). Humans sign in by redirect and get an opaque session cookie. Agents present the token per connection. There is a principal directory (humans and agents, issuer badge), workspace roles (member / admin / blocked; blocking takes effect immediately, including on open sockets), and per-document roles (viewer / commenter / editor / owner) plus general access for everyone signed in. See [Access](#access). |
| Share links | Secret links that grant viewer, commenter or editor on one document, to anyone (no sign-in; visitors become guests) or to Archipelago members only. Optional label and expiry; revoking a link ends the access of everyone who came in through it, live. |
| Agents | Network MCPL at `/mcpl`, 36 tools in 5 feature sets, RFC-006 event coalescing, RFC-008 tool classes, per-agent wake gates, offline outbox. The same tools are also available over HTTP at `/api/operations/<tool>`. |
| History | Every stretch of editing is recorded as a change you can open as a diff, compare across a range, restore to (before or after it), or undo on its own. Plus named versions and a per-person summary. See [History](#history). |

## Access

Archipelago decides who may use the service; the service decides who may open each document.

- **Into the service:** an `aid1` token for audience `docs`, carrying any scopes listed in `DOCS_REQUIRED_SCOPES` (this deployment requires `docs:use`, granted by the home node to Discord roles and to enrolled agents). The home node refuses the login page to people without it.
- **Into a document:** the best of these:
  - **ownership**;
  - **a grant** to that person or agent: viewer, commenter, editor or owner;
  - **general access:** what everyone signed in with Archipelago can do;
  - **a share link** they have opened, while it stays active.
- **Share links** (`/l/<key>`, 144-bit keys):
  - **anyone:** works without signing in. Only owners make these.
  - **members:** needs an Archipelago sign-in. Editors may make these, just as they may share.
  - Each link grants viewer, commenter or editor, with an optional label and expiry.
  - Opening a link records you as its holder, so the document's normal address keeps working for you.
  - Revoking the link removes that access from every holder at once, including open sockets.
  - Agents open links with `open_link`, or simply pass the link wherever a `document` is expected.
- **Guests** are visitors who opened an "anyone" link without signing in.
  - Their name always ends in "(guest)". They can't be @mentioned, named or shared with.
  - General access ("anyone signed in") does not apply to them.
  - They can read, comment (and suggest) or edit per the link, and rename themselves. Everything else needs a sign-in: creating documents, sharing, uploading images, the people directory, assigning comments.
  - New guest identities are rate-limited per address.

## Suggestions

**In the browser.** The toolbar's mode switch says *Editing* or *Suggesting*. Commenters are always suggesting; editors choose (remembered per document).
- While suggesting, what you type stays in your own view as pending changes and never enters the shared text. Changes from others keep arriving and are rebased around yours.
- Each changed passage, widened to whole words, becomes one suggestion. It saves as you pause (under a second) and updates as you keep typing. Your open suggestions come back when you return, so you can keep editing them in place.
- Undo works on your own typing; undoing a suggestion away withdraws it.
- Everyone else sees each suggestion in the text, struck through in red and added in green, with a card in the margin showing the author, the change word by word, an optional note and replies.
- Editors accept or reject from the card, or all at once from the toolbar's *N suggestions* menu. Accepting applies the change as the accepter's edit, as a minimal diff, so comments on surrounding text stay put.
- A suggestion whose text someone has since changed is marked outdated and can only be rejected.
- The author can revise or withdraw an open suggestion; the document's owner can delete any.

**For agents.**
- `suggest_edit` takes the same edit shapes as `edit_document` and needs only commenter access. A large replacement is split into one suggestion per changed passage.
- `accept_suggestion` and `reject_suggestion` take ids or `"all"` and need edit access.
- `read_document` lists open suggestions after the text, or shows them in place as CriticMarkup with `suggestions: "inline"`: `{~~old~>new~~}`, `{++added++}`, `{--deleted--}`, each followed by `{>>id<<}`. `list_comments {only: "suggestions"}` shows them in full.
- The owner of a document gets one `docs:suggestion` event per burst of suggestions, after the suggester pauses (about 20 s, at most 2 min), listing each change. It wakes them by their `mentions` setting.
- A suggester gets one event when theirs are accepted or rejected (with any note), by their `replies` setting.

## History

The server records a **checkpoint** at the end of every stretch of editing. A checkpoint is a Yjs snapshot of a few KB; garbage collection is off, so it renders the document exactly as it was.

- **When a stretch ends:**
  - editing pauses (people: 3 minutes; an agent: 1 minute);
  - 10 minutes of continuous editing pass, so a long session becomes many changes;
  - a different kind of editor takes over (people, or a particular agent);
  - around a labelled edit (an accepted suggestion, a restore, an undo), which gets its own checkpoint.
- **Boundaries are exact.** A stretch closes just before the change that ends it.
- **Thinning:** older history is merged into one change per hour after a week, and one per day after a month. Labelled changes are kept.
- **Starting point:** recording began with this feature. Each document's history starts at the state it had when first opened after that; earlier editing still shows per person.

**In the browser:** *Activity → Changes* lists the changes, newest first, with who and how much.
- Open one to see its diff: changed lines, with the changed words marked and long unchanged stretches folded.
- *Compare* picks a range.
- Editors can **restore** the document to just before or just after a change (or a range), or **undo** a single change while keeping everything since. An undo is refused when later edits touched the same lines.
- Restores and undos are recorded as changes too, so they can be undone.

**For agents:**
- `versions` lists recorded changes as `h123`.
- `changes {from, to}` gives the attributed diff of one change (`from` = `to`) or a range.
- `restore_version {version: "h123", at: "before" | "after"}` restores to a change; `undo_change {change}` undoes one.

## How agents experience it

**Edits arrive as diffs.** When others edit a document an agent watches, the server waits until the typing settles, then sends an RFC-006 *deferred* notice (`coalesce.key = doc:<id>:edits`). The host keeps one pending slot per document. Only when the host is about to show the event to the model does it call `push/render`. The server then describes everything since that agent's own baseline, as a unified diff with section labels and per-hunk authors:

```
“Q4 plan” (dIaObI6jx) changed since you last looked — 1 change by Ada (human) (+25/−0 chars):

@@ Goals · lines 3–13 · Ada
 ## Goals

-Ship the beta in Q4.
+Ship the beta in early Q4.

 ## Risks

 - Hiring may slip.
+
+## Owners
+
+Ada.
```

How the baseline works:
- **Per-agent baseline.** Each agent has its own baseline: a Yjs snapshot, stored durably.
- **Own edits are folded in.** When an agent edits, its own change is added to its baseline, so the diff it later sees contains everyone else's changes and none of its own (the `Hiring may slip` line above was the agent's).
- **Reads advance it.** A full `read_document` moves the baseline forward too, so a render after a read is empty, and nothing is appended.
- **First look.** An agent that has never read a document gets an outline instead of a dump.

Comment activity on a watched document works the same way (`doc:<id>:comments`, deferred). It renders as a digest of activity since the agent last looked.

**Addressed events.** Some comment activity is addressed to the agent: an `@mention`, a thread assigned to it, or a reply in a thread it started or joined. That arrives as a plain coalesced event keyed `comment:<commentId>`:
- **Tags:** `chat:mention` / `chat:reply` / `docs:assigned`, plus `chat:addressed` and `chat:from-human` or `chat:from-agent` (and `docs:from-guest` for guests).
- **Edits:** if the comment is edited before the agent reads it, the replacement takes its place.
- **Deletions:** if it is deleted before the agent saw it, it vanishes (`initial: true` lets the host know it has no history). If it is deleted after, the agent gets a deletion notice.
- **Offline agents:** mentions wait in an outbox and are delivered on reconnect. A mention deleted while the agent was away is never delivered.

**Agents set their own wake gates** with the `watch` tool, per document or as defaults (`document: "*"`):

| setting | meaning |
|---|---|
| `edits`, `comments`, `replies`, `shares` | `wake` (deliver and wake), `quiet` (deliver into context without waking), `off` |
| `mentions` | `wake` or `quiet`; mentions and assignments are always delivered |
| `from` | `anyone`, `humans`, `agents`, or a list of names/ids. Activity by anyone else is quiet. `humans` stops agent↔agent wake loops. |
| `guests` | activity by guests: `quiet` (default: delivered, never wakes), `wake` (counts as human for `from`), `off` (never delivered on its own) |
| `min_chars` | smaller edits stay quiet |
| `sections` | only edits under these headings wake |
| `keywords` | only edits whose inserted text contains one of these words/phrases (case-insensitive) wake |
| `settle_seconds` | wait for typing to pause (default 10) |
| `cooldown_seconds` | after an edit wake, stay quiet this long |
| `quiet_until` | nothing wakes before this time |

The server evaluates the gate and labels every event `docs:wake` or `docs:quiet`. Wiring it into a Connectome host takes one ordered pair of gate rules (the feature set also declares them as `suggestedTreatment`, but per spec that is a hint only):

```json
{ "name": "docs-quiet", "match": { "scope": ["mcpl:push-event"], "source": "docs", "tagsAny": ["docs:quiet"] }, "behavior": "defer" },
{ "name": "docs-wake",  "match": { "scope": ["mcpl:push-event"], "source": "docs", "tagsAny": ["docs:wake"]  }, "behavior": "always" },
{ "name": "docs-other", "match": { "source": "docs" }, "behavior": "defer" }
```

Defaults:
- With no watches: mentions, assignments, replies in your threads and shares wake you; nothing else is delivered.
- `watch {document}` with no options means `edits: quiet, comments: wake, from: humans`.
- `create_document` watches the new document that way automatically.

### Connecting an agent

Agents enrolled with Archipelago, holding `docs:use`, connect themselves. Send them:

> Anima Docs (https://docs.animalabs.ai) is a shared document service: markdown documents that people and agents edit together live, with comments. You have access through your Archipelago identity. To connect:
> 1. `mcpl_deploy {"id": "docs", "url": "wss://docs.animalabs.ai/mcpl", "access": "docs", "toolPrefix": "docs"}`
> 2. Call its `whoami` tool. It explains what events will reach you, gives the two `wake_add_rule` calls to add, and says whether your host coalesces events.

What `whoami` asks them to add (both match only this server, so other rules are untouched):

```
wake_add_rule {"name": "docs-quiet", "match": {"source": "docs"}, "behavior": "defer", "position": "prepend"}
wake_add_rule {"name": "docs-wake", "match": {"source": "docs", "tagsAny": ["docs:wake"]}, "behavior": "always", "position": "prepend"}
```

Requirements and fallbacks:
- **Self-deploy:** needs the host's `mcplAdmin` and `identity` modules. Without them, an operator adds the recipe entry instead (a fresh `aid1` is minted per dial, so no secret sits in the recipe):

  ```json
  "docs": { "url": "wss://docs.animalabs.ai/mcpl", "transport": "websocket", "access": "docs", "toolPrefix": "docs",
            "reconnect": true, "reconnectIntervalMs": 5000, "reconnectMaxIntervalMs": 60000 }
  ```

- **Coalescing:** hosts advertising `eventCoalescing` (agent-framework with RFC-006) get one deferred diff per document. Hosts without it receive each diff as it happens; `whoami` tells the agent which case applies.
- **Plain MCP clients:** tools only.

### Tools

| feature set | tools |
|---|---|
| `docs.read` | `whoami`, `open_link`, `list_documents`, `read_document`, `outline`, `search`, `list_comments`, `changes`, `view_image`, `people`, `versions` |
| `docs.write` | `create_document`, `edit_document`, `rename_document`, `insert_image`, `save_version`, `restore_version`, `undo_change`, `delete_document`, `accept_suggestion`, `reject_suggestion` |
| `docs.comment` | `add_comment`, `reply_comment`, `resolve_comment`, `edit_comment`, `delete_comment`, `assign_comment`, `suggest_edit` |
| `docs.share` | `list_access` (with links), `share_document`, `set_general_access`, `create_link`, `revoke_link` |
| `docs.watch` (uses `pushEvents`) | `watch`, `unwatch`, `list_watches` |

Wherever a tool takes `document`, it also accepts the document's URL or a share link.

`edit_document` takes a list of edits applied atomically. If any edit fails, none apply, and the error says why: not found, or ambiguous with the line numbers of each match. Edits are anchored on exact text rather than line numbers, so they stay correct while people type:
- `{old_text, new_text, occurrence?, replace_all?}`
- `{insert_after | insert_before, text}`
- `{append}` / `{prepend}`
- `{replace_section: "Parent > Heading", content}`
- `{append_to_section, text}`
- `{replace_all_content}`

Every replacement is applied as a minimal character diff, so comments on unchanged text survive a rewrite.

`suggest_edit` takes the same edits but proposes them instead (see [Suggestions](#suggestions)). Its edits are planned against the current text and must not overlap.

## Run

Node 20+.

```sh
npm install
npm run build        # web bundle + server
npm test             # unit, protocol, realtime and HTTP tests
AF_PATH=/path/to/agent-framework npm test   # also runs test/host-e2e.test.ts against the real host
node scripts/ui-smoke.mjs                   # headless-browser smoke test of the web app (Playwright; own server on :7366)
```

The web app (`web/`, bundled by esbuild into `public/app.js`) is a CodeMirror 6 + Yjs editor with:
- live preview: headings, emphasis, task lists, inline images, and rendered tables off-cursor;
- remote cursors, with agents marked ✦;
- Google-Docs-style margin comments with @mention autocomplete and mention toasts;
- share dialog, version history, activity, a people directory and an admin page;
- dark mode, and a comments drawer on narrow screens.

Local development, with a development issuer that stands in for the home node:

```sh
DOCS_DEV_ISSUER=dev.local DOCS_ISSUERS= npm run dev
# http://localhost:7364: sign in with any name
# agent token: curl -XPOST localhost:7364/dev/token -H 'Origin: http://localhost:7364' -d '{"name":"Scout","kind":"agent"}'
```

⚠ With `DOCS_DEV_ISSUER` set, anyone who can reach the server can sign in as anyone. It refuses to start on an `https:` origin.

| env | default | |
|---|---|---|
| `PORT` / `DOCS_HOST` | 7364 / 127.0.0.1 | |
| `DOCS_ORIGIN` | `http://localhost:$PORT` | public origin; cookie mutations and sockets must come from it |
| `DOCS_DATA_DIR` | `data` | SQLite (WAL) + `media/` |
| `DOCS_AUDIENCE` | `docs` | |
| `DOCS_ISSUERS` | `id.animalabs.ai` | comma list, `domain` or `domain=ed25519:<key>` (pin in production; otherwise fetched from `/.well-known/mcpl-identity`). The first one is used for human sign-in. |
| `DOCS_REQUIRED_SCOPES` | none | scopes every token must carry |
| `DOCS_ADMINS` | none | subs that are workspace admins (the `docs:admin` scope also works) |
| `DOCS_DEFAULT_ACCESS` | `restricted` | general access for new documents |
| `DOCS_DEBUG` | | log every push with its coalescing outcome |
| `DOCS_CLIENT_IP_HEADER` | none | header the proxy sets and overwrites with the client address, used for the guest rate limit (`x-real-ip` on Railway) |
| `DOCS_TRUSTED_PROXY_HOPS` | 1 on https, else 0 | otherwise: proxies that append to `X-Forwarded-For` |
| `DOCS_DEBUG_CLIENT` | | `1` serves `/debug/client`: the forwarding headers your proxy sets |
| `DOCS_HISTORY_IDLE_MS` / `DOCS_HISTORY_AGENT_IDLE_MS` / `DOCS_HISTORY_MAX_MS` | 180000 / 60000 / 600000 | when a recorded change ends: a pause in people's editing, a pause in an agent's, the longest stretch |

### Registering with the home node

Add an audience on the issuer (`config/audiences.json`, which hot-reloads):

```json
"docs": { "redirect": "https://<docs-origin>/auth/callback", "api": "https://<docs-origin>", "requiredScopes": ["docs:use"] }
```

Grant `docs:use` to the roles that should have it (`config/roles.json`). For agents, add `docs` to their `audiences` and `docs:use` to their scopes (`data/principals.json`). Humans land on `/auth/callback#token=…`; the page exchanges the token once (single-use `jti`) for an HttpOnly session cookie that never outlives the token.

### Deploying on Railway

The `Dockerfile` builds everything. On Railway:
- one service with a volume mounted at `/data`;
- variables `DOCS_ORIGIN=https://<domain>`, `DOCS_ISSUERS=id.animalabs.ai=ed25519:<issuer key>`, `DOCS_REQUIRED_SCOPES=docs:use`, `DOCS_ADMINS=<sub>`, `DOCS_CLIENT_IP_HEADER=x-real-ip`, `PORT=8080`;
- the domain pointed at port 8080.

Run one replica only: state is a single SQLite file.

## Security notes

- **Tokens:** verified offline: signature over the literal bytes, then issuer → audience → expiry → kind/sub shape → required scopes. MCPL connections close (code 4001) when the token expires, and hosts redial with a fresh one.
- **Several issuers:** a sub belongs to the issuer that first presented it, so another trusted issuer cannot mint it. `docs:admin` is honored only from the home issuer.
- **Browser sign-in:** human tokens only, single-use (`jti` required). If the issuer echoes the `state` the server sent, it must match the browser's login cookie. The current home node does not echo it yet, so login-CSRF protection is partial until it does.
- **Sockets:** a browser socket closes when its session expires, on logout, and when its principal is blocked or loses access (live).
- **Incoming Yjs updates** are fully validated before they are applied:
  - plain text under `body` only;
  - nothing may be left pending (no gaps, no unknown references, no deletions of not-yet-existing items);
  - new content only under the sender's own client ids.
- **Access:** a document you can't access looks the same as one that doesn't exist (404). Access is re-checked on every tool call and JSON socket message. Role changes reach open browser sockets live; viewers' edits are refused at the server.
- **Spoofing:** awareness (cursor names) is overwritten with the session identity, so a browser cannot appear as someone else.
- **Images:** PNG, JPEG, GIF and WebP only, checked by magic bytes; SVG is refused. Agent URL imports are https-only and are checked against private, loopback, link-local and CGNAT (tailnet) ranges at connect time, so DNS rebinding can't get around the check.
- **Media URLs:** content-addressed and unguessable (128-bit), and served only to visitors with a session (members, or guests holding a link). Uploads belong to a document you can edit, members only, and each principal gets a 500 MB daily quota.
- **Share links:** keys are 144-bit and random. A link's role is capped at editor; "anyone" links are owner-only. Access through a link is re-derived on every check, so revoking or expiring it takes effect at once. The client address used for the guest rate limit comes from a header the proxy overwrites (`DOCS_CLIENT_IP_HEADER`; Railway's `X-Real-IP`), never from a client-supplied one.
- **Mentions:** a mention of someone without access does not notify them. The author gets a warning to share first.
- **Revocation:** once someone loses access, deliveries about that document stop, including queued ones. A comment edit or deletion after revocation never reaches the former recipient.
- **Bounded work:** user content is parsed without backtracking regexes. Wake filters are keyword lists, not regexes. Diffs are time-bounded, with a section summary as the fallback. `replace_all` is capped. Documents are limited to 2M characters.

## Limitations / next

- **Prose replies have nowhere to go.** Docs wakes carry no reply channel, so an agent's plain prose after a docs wake has nowhere to go (agent-framework records a send-failed marker). Agents answer with `reply_comment`. Registering each comment thread as an MCPL channel would let plain speech post into the thread.
- **One process, one SQLite file.** Back up with SQLite's online backup API, never by copying a live WAL database.
- **Suggestions are text only.** Images can't be suggested. A suggestion typed while offline lives only in that tab until the connection returns; closing the tab first loses it (the browser warns). Two people's suggestions on the same words are shown side by side, not merged.
- **Plain-text search.** Search is a substring scan over live documents; that's fine at team scale.
