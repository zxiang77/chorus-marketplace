# Chorus Marketplace

Claude Code plugin marketplace for [Chorus](https://github.com/zxiang77/chorus) — route a single Discord bot to multiple Claude Code sessions.

## Install

```bash
# Add this marketplace
claude plugin marketplace add chorus-marketplace --source github --repo zxiang77/chorus-marketplace

# Install the relay plugin
claude plugin install chorus-relay@chorus-marketplace
```

## What's included

- **chorus-relay** — MCP channel server that bridges the Chorus Hub to a Claude Code session. One relay per Discord channel.

## Also needed

The Chorus Hub runs separately:

```bash
pip install chorus-hub
```

See the [main Chorus repo](https://github.com/zxiang77/chorus) for full setup instructions.
