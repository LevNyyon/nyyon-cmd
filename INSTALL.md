# Installing your Nyyon Command Center

You end up with your own command center on your own Cloudflare account:
your database, your files, your keys. Nothing phones home.

## What you need

- A Cloudflare account (free tier works). No GitHub account is needed:
  the code lives on your machine, Cloudflare runs it.
- Node 22+ on your machine, for the one-time bootstrap.
- An Anthropic API key (console.anthropic.com). The wizard asks for it.

## Install

```bash
git clone https://github.com/LevNyyon/nyyon-cmd.git
cd nyyon-cmd
npx wrangler login
node scripts/bootstrap.mjs
```

The bootstrap creates a D1 database and an R2 bucket, applies the schema,
deploys the worker, and prints a setup URL. Open it. The wizard walks you
through:

1. **Account**: your operator login.
2. **Model key**: the Anthropic key, verified with a real call.
3. **Connections**: the optional gates, each with instructions:
   SerpApi, People Data Labs, Twilio (prospect enrichment), Truecaller
   (manual, keyless), Plugin publishing (GitHub), LinkedIn (li_at cookie).
   All skippable; all editable later in Settings.

When you finish, say hi to Nyo. He runs the voice interview in chat. It
writes the documents that make everything the system drafts sound like
you. Until it is done, writing surfaces stay generic on purpose.

## After setup

- **Publishing**: articles and social posts leave only through your
  outbound webhooks (Settings → Outbound webhooks). No receiver yet?
  The "copy LLM setup prompt" button hands any LLM everything it needs
  to help you build one.
- **Plugins**: the Expand page carries a builder prompt for your own
  LLM plus the import box. Data-only plugins are live at import. A plugin
  that carries code needs a fresh deploy, from your machine:

```bash
node scripts/materialize.mjs --url https://<your-install>.workers.dev
```

  It writes the plugin files into your checkout, deploys, and reports back
  so the install flips the plugin active. Prefer hands-off? Fork the repo,
  configure Settings -> Plugin publishing with your fork and a fine-grained
  token (Contents read/write), add a `CLOUDFLARE_API_TOKEN` repo secret, and
  every push to `main` deploys, plugins included. Optional either way.
- **Updates**: `git pull`, then `node scripts/bootstrap.mjs` again. It reuses
  everything and only redeploys.
- **A custom domain** is optional: add a `routes` entry in
  workers/api/wrangler.jsonc once the zone lives on your account.

## Day-2 notes

- Every credential you enter is stored in YOUR database (gateway_config)
  or as Cloudflare secrets on YOUR account.
- Knowledge docs are live configuration: editing one changes behavior
  with no deploy.
- Errors always land in Activity, with full information. If something
  broke, that is where it says why.
