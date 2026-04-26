# Changelog

## 1.1.0

- Development: `@types/node` ^22, `engines.node` `>=22`, README notes for local tooling.
- Two providers only: Ollama (local) and OpenAI-compatible cloud; legacy Groq enum maps to cloud.
- Abort in-flight LLM requests when the hover is cancelled; configurable Ollama base URL.
- Richer prompts: file path, severity, source/code, message, and surrounding source lines.
- Smarter diagnostic choice when several overlap: errors before warnings, then smallest range.
- Safer cloud and Ollama responses: non-JSON bodies surface readable errors.
- Commands: Configure wizard, Pick Local Model (queries Ollama `/api/tags`), Enter Cloud API Key.
- Optional `cloudHeaders` for provider-specific headers; cloud URL presets in the wizard.
- In-flight request dedupe removed so cancelling one hover never aborts another client waiting on the same diagnostic.
- Extension sources live under `src/`; narrower activation via common `onLanguage` events and commands.
- Default cloud base URL and model updated toward generic OpenAI-style defaults.

## 1.0.0

- Initial release: hover explanations, Ollama and OpenAI-compatible cloud, secret storage for API keys.
