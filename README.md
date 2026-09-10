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

The code: https://github.com/LevNyyon/nyyon-cmd
Read its README.md and INSTALL.md first. The code will live on my machine;
the running system lives on my Cloudflare account. No GitHub account needed.

I already have: a Cloudflare account (email verified) and an Anthropic API
key.

Do these, in order:

1. If you can connect to Cloudflare yourself, do it, so you can see my
   account and fix things directly. The connector is
   https://mcp.cloudflare.com/mcp (it opens a Cloudflare login where I
   choose what you may do). In Claude the shortcut is:
   /plugin marketplace add cloudflare/skills
   Connected or not, the deploy itself happens with the commands in step 3;
   don't create databases or workers by hand.

2. Make sure my computer has what it needs: git and Node 22 or newer
   (https://nodejs.org). Give me the exact install steps for my system.

3. Get the code and deploy it:
     git clone https://github.com/LevNyyon/nyyon-cmd.git
     cd nyyon-cmd
     npx wrangler login
     node scripts/bootstrap.mjs
   This creates my database, deploys the system, and prints my setup link.

4. I open the setup link. The wizard asks for my login, my Anthropic key,
   and some optional connections that each explain themselves. Help me
   decide what to skip (everything optional is fine to skip).

5. When setup finishes, I open the app and tell Nyo: "let's do the
   interview". Fifteen minutes; it makes everything sound like me.

6. Publishing goes through webhooks I control (Settings -> Outbound
   webhooks). That page has a "copy LLM setup prompt" button; I'll paste it
   to you when I'm ready and you'll help me build the receiving end.

Start now: tell me which of steps 1-3 you can do for me, then begin.
```

Prefer doing it by hand? The four commands and the details are in [INSTALL.md](INSTALL.md).

## What's inside

**Hot Takes** writes articles and posts in your voice from topics you watch. **Prospecting** enriches and qualifies leads, and watches the people you care about. **Daily Planner** turns a short chat into a day plan. **Knowledge** holds every rule as an editable doc. **Expand** lets your own AI build plugins for it.

Everything the system does is visible in Activity, errors included. Every credential stays in your database or your Cloudflare secrets.
