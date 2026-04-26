# AI Error Translator

Instantly understand and fix compiler errors with local AI (Ollama) or any cloud model that exposes an OpenAI-compatible Chat Completions endpoint. Hover over a diagnostic and get a plain-English explanation in the tooltip.

## Features

- Hover to explain diagnostics directly in the editor (requests cancel when you move the pointer away).
- Local mode with configurable Ollama host and model; optional **Pick Local Model** via Ollama’s tag list.
- Cloud mode with configurable base URL, model ID, and optional extra HTTP headers.
- **Configure** command walks through Local vs Cloud, presets (Groq, OpenAI, OpenRouter, custom), API key, and model.
- Secure cloud API key storage using VS Code Secret Storage.
- Debounce and caching of completed explanations keyed by document version and diagnostic details.

## Quick setup

1. Command Palette → **AI Translator: Configure** (or tune settings under **AI Error Translator**).
2. Local: set **Ollama Base Url** if not `http://localhost:11434`, pull a model (`ollama pull …`), then use **AI Translator: Pick Local Model** or set **Local Model** manually.
3. Cloud: choose a preset URL or enter your own, run **AI Translator: Enter Cloud API Key**, set **Cloud Model**.

The extension activates when you open a supported language file or run any AI Translator command. If you need hover on a language not listed in `package.json` `activationEvents`, add an `onLanguage:…` entry for that language id.

## Settings (summary)

| Setting | Purpose |
| --- | --- |
| `aiTranslator.provider` | `Ollama (Local)` or `Cloud (OpenAI-Compatible)` |
| `aiTranslator.ollamaBaseUrl` | Ollama server root (default `http://localhost:11434`) |
| `aiTranslator.localModel` | Ollama model name |
| `aiTranslator.cloudBaseUrl` | API root without `/chat/completions` |
| `aiTranslator.cloudModel` | Provider model id |
| `aiTranslator.cloudHeaders` | Extra string headers merged into cloud requests |
| `aiTranslator.contextLines` | Lines of code around the error sent to the model |
| `aiTranslator.debounceMs` | Hover delay before calling the model |

## Examples of cloud base URLs

- OpenAI: `https://api.openai.com/v1`
- Groq: `https://api.groq.com/openai/v1`
- OpenRouter: `https://openrouter.ai/api/v1`

## Development

Use **Node.js 22 or newer** for `npm` scripts and typings (`engines.node` in `package.json`).

```bash
npm install
npm run compile
```

Press F5 in VS Code to launch the Extension Development Host.

Before publishing, set `publisher`, `repository`, and `bugs` in `package.json` to your own values.
