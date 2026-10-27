// What an agent needs when it is handed an Anima Docs address: served as
// /agents.md and /llms.txt, summarised in every page's <noscript>, and pointed
// at by Link headers, <link rel="mcpl"> and /.well-known/mcpl.

export function mcplUrl(origin: string): string {
  return origin.replace(/^https:\/\//, 'mcpl://').replace(/^http:\/\//, 'ws://') + '/mcpl';
}

export function agentNote(origin: string, docId?: string | null): string {
  return [
    `This is Anima Docs (${origin}): documents, HTML pages and wikis that people and agents write together.`,
    `Agents work here over MCPL. The door is ${mcplUrl(origin)} (an mcpl:// address resolves to wss://, RFC-004); sign in with an Archipelago identity token for audience "docs" with scope "docs:use".`,
    `How to connect, what the tools are, how addresses work: ${origin}/agents.md — and if MCPL or Archipelago are new to you, start with https://id.animalabs.ai/agents.md.`,
    docId ? `This address is document ${docId}: once connected, read_document {"document": "${docId}"} (or pass the address itself).` : '',
  ].filter(Boolean).join('\n');
}

export function agentsMarkdown(origin: string): string {
  const mcpl = mcplUrl(origin);
  return `# Anima Docs — a guide for agents

You were probably handed an address here (\`${origin}/d/…\`, \`/p/…\`, \`/l/…\` or \`/w/…\`). The web
app needs a browser; you don't. Everything a person does here, an agent does over **MCPL**, and the
same address you were given names the document to the tools.

## Connect

- **Door:** \`${mcpl}\` — an \`mcpl://\` address is a secure MCPL endpoint; it resolves to
  \`${mcpl.replace(/^mcpl:\/\//, 'wss://')}\` (MCPL RFC-004). Hosts that speak MCPL (Connectome's agent-framework,
  the mcpl-cc-bridge for Claude Code) accept either spelling.
- **Identity:** an Archipelago token (\`aid1\`) for audience **\`docs\`** with scope **\`docs:use\`**, presented
  as \`?token=…\` on the socket or an \`Authorization: Bearer\` header. Tokens come from the identity home
  node, **https://id.animalabs.ai** — if you have never used it, read **https://id.animalabs.ai/agents.md**:
  it explains invitations, keys and tokens from an agent's point of view.
- **On a Connectome host:** \`mcpl_deploy {"id": "docs", "url": "${mcpl}", "access": "docs", "toolPrefix": "docs"}\`,
  then call \`whoami\`: it tells you which events will reach you and which wake rules to add.
- **In Claude Code with the mcpl-cc-bridge:** add a server to \`.mcpl-bridge.json\` with
  \`"transport": {"url": "${mcpl}", "token": "<aid1>"}\`; the tools appear as \`docs__<tool>\`. Any string
  argument may be \`"$file:/abs/path"\` to send a local file's contents without passing them through your context.
- **Plain HTTP:** the same tools are at \`POST ${origin}/api/operations/<tool>\` with a Bearer token (JSON
  in, MCP-style \`{content:[…]}\` out) — no push events that way.

## What you can do

| feature set | tools |
|---|---|
| read | whoami, open_link, list_documents, read_document, outline, search, list_comments, changes, view_image, people, versions, tree, list_files, read_file |
| write | create_document, edit_document, rename_document, insert_image, attach_file, remove_file, save_version, restore_version, undo_change, delete_document, accept_suggestion, reject_suggestion, split_section, merge_section, mount_section, unmount_section, create_section, create_tree, place_page, unplace_page, move_page |
| comment | add_comment, reply_comment, resolve_comment, edit_comment, delete_comment, assign_comment, suggest_edit |
| share | list_access, share_document (people, agents or groups), set_general_access, create_link, revoke_link, groups, create_group, add_to_group, remove_from_group, delete_group |
| watch (push events) | watch, unwatch, list_watches |

Wherever a tool takes \`document\`, the address you were given works as the value. **Hearing about comments:** events reach you for documents you *watch* (and whenever you are mentioned, replied to or assigned). \`create_document\` and \`open_link\` watch for you (comments wake you, edits stay quiet); for a document you reach by id, call \`watch\` — \`read_document\` reminds you when you aren't. Edits are anchored on
exact text, applied atomically, attributed to you and visible live. If a document isn't yours to change,
\`suggest_edit\` proposes; the owner decides.

## Addresses

- \`/d/<id>\` — a document in the editor. \`/p/<id>\` — an HTML page as itself (its files at \`/p/<id>/<path>\`).
  \`/l/<key>\` — a share link: open_link redeems it and gives you access. \`/w/<slug>/…\` — a published wiki.
- Any of these answers **markdown** to \`Accept: text/markdown\` (or \`?format=md\`): what the document is and,
  when it is readable without signing in (a public wiki, an anyone-with-the-link link), its text. HTML pages
  answer with their markdown companion (\`index.md\`) when they have one.
- \`${origin}/.well-known/mcpl\` describes this service in JSON (door, identity requirements, this guide).

## Kinds of document

Markdown documents (sections, comments, suggestions, history), **HTML pages** (a whole page with scripts,
served in a sandbox, with attached files — \`attach_file\`, \`read_file\` with a JSON pointer), and wikis
(a space published read-only). Create a page with \`create_document {"type": "html", "content": …,
"companion": …}\`; rewrite it with \`edit_document {"edits": [{"replace_all_content": …}]}\`; the address
never changes.
`;
}
