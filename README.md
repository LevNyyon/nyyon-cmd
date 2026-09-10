# Nyyon Command Center

Your own AI operator backstage, running on your own Cloudflare account. Nyo, the assistant at the center, learns your voice and runs your writing, prospecting and planning. Your keys, your data, your system.

## Get started

1. **Create a Cloudflare account** (free): https://dash.cloudflare.com/sign-up
2. **Verify your email** (check your inbox and click the link Cloudflare sent).
3. **Create an Anthropic API key**: https://console.anthropic.com/settings/keys (sign up at https://console.anthropic.com if you don't have an account, and add a few dollars of credit).
4. **Copy the prompt below into your AI** (Claude, ChatGPT, Claude Code, Cursor, any of them) and follow along. It handles everything else.

```text
Set up my own Nyyon Command Center for me. I may not be technical: go one
step at a time, give me exact things to click or paste, and check I'm done
before moving on. Never ask me to paste a password or API key into this
chat; tell me where to paste it instead.

The system's code: https://github.com/LevNyyon/nyyon-cmd
Read its README.md and INSTALL.md first.

How it works: I take a copy of the code into MY OWN GitHub repo
(independent of the original), my machine edits it, and my Cloudflare
account runs it. Every push to my repo's main branch deploys.

I already have: a Cloudflare account (email verified) and an Anthropic API
key.

Do these, in order:

1. GitHub. If I don't have an account: https://github.com/signup
   Create my own empty repo (private is fine): https://github.com/new
   (a name like "my-cmd" works).

2. If you can connect to Cloudflare yourself, do it, so you can see my
   account and fix things directly. The connector is
   https://mcp.cloudflare.com/mcp (it opens a Cloudflare login where I
   choose what you may do). In Claude the shortcut is:
   /plugin marketplace add cloudflare/skills
   Connected or not, the deploy happens with the commands below.

3. Make sure I have git and Node 22+ (https://nodejs.org). Then take the
   code and make it mine:
     git clone https://github.com/LevNyyon/nyyon-cmd.git my-cmd
     cd my-cmd
     git remote set-url origin https://github.com/MY-USER/MY-REPO.git
     git push -u origin main

4. First boot:
     npx wrangler login
     node scripts/bootstrap.mjs
   It creates my database, deploys, pushes my install's config to my repo,
   and prints my setup link.

5. Wire up push-to-deploy:
   a. Create a Cloudflare token with the "Edit Cloudflare Workers"
      template: https://dash.cloudflare.com/profile/api-tokens
   b. Add it to MY repo as an Actions secret named CLOUDFLARE_API_TOKEN:
      my repo -> Settings -> Secrets and variables -> Actions
   From then on every push to main deploys.

6. Setup wizard. I open the printed link. It asks for my login, my
   Anthropic key, and optional connections that explain themselves. In
   "Plugin publishing" I enter MY repo and a fine-grained GitHub token
   (https://github.com/settings/personal-access-tokens/new, scoped to only
   my repo, permission Contents: read and write) so plugins deploy through
   my repo too.

7. When setup finishes, I open the app and tell Nyo: "let's do the
   interview". Fifteen minutes; it makes everything sound like me.

8. Publishing goes through webhooks I control (Settings -> Outbound
   webhooks). I'll set those up with you later.

Start with step 1.
```

Prefer doing it by hand? The four commands and the details are in [INSTALL.md](INSTALL.md).

## What's inside

**Hot Takes** writes articles and posts in your voice from topics you watch. **Prospecting** enriches and qualifies leads, and watches the people you care about. **Daily Planner** turns a short chat into a day plan. **Knowledge** holds every rule as an editable doc. **Expand** lets your own AI build plugins for it.

Everything the system does is visible in Activity, errors included. Every credential stays in your database or your Cloudflare secrets.
