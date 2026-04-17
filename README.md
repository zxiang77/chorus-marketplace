# Chorus Marketplace

Claude Code plugin marketplace for [Chorus](https://github.com/zxiang77/chorus) — route a single Discord bot to multiple Claude Code sessions. Like the [official Discord plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord), but multi-session — each channel gets its own Claude Code session.

This marketplace is for installing Chorus during its research preview. Once the plugin is on the [official marketplace allowlist](https://github.com/anthropics/claude-plugins-official), installation shifts there and this repo becomes a secondary channel.

## Install

```bash
# Add this marketplace
claude plugin marketplace add zxiang77/chorus-marketplace

# Install the relay plugin
claude plugin install chorus-relay@chorus-marketplace
```

Then also install the Hub (runs as a separate process):

```bash
pip install chorus-hub
```

## What's included

- **chorus-relay** — MCP channel server that bridges the [Chorus Hub](https://github.com/zxiang77/chorus) to a Claude Code session. One relay per Discord channel.

## Full setup

See the [main Chorus repo](https://github.com/zxiang77/chorus) for prerequisites, configuration, architecture, and troubleshooting.

## License

MIT
