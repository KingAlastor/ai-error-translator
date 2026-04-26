import * as vscode from "vscode";

let statusBar: vscode.StatusBarItem;
let debugChannel: vscode.OutputChannel;
let aiDiagnosticCollection: vscode.DiagnosticCollection;
const explanationCache = new Map<string, string>();
const aiDiagnosticsByUri = new Map<string, Map<string, vscode.Diagnostic>>();
const inFlightRequests = new Set<string>();

type ProviderType = "Ollama (Local)" | "Cloud (OpenAI-Compatible)";

interface TranslatorConfig {
  provider: ProviderType;
  localModel: string;
  cloudModel: string;
  cloudBaseUrl: string;
  ollamaBaseUrl: string;
  debounceMs: number;
  contextLines: number;
  cloudHeaders: Record<string, string>;
}

const CLOUD_PRESETS: { label: string; url: string }[] = [
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "Anthropic (OpenAI-compatible proxy)", url: "" },
  { label: "Custom base URL…", url: "__custom__" },
];

export function activate(context: vscode.ExtensionContext) {
  debugChannel = vscode.window.createOutputChannel("AI Error Translator");
  debugChannel.appendLine("Extension activated");
  aiDiagnosticCollection = vscode.languages.createDiagnosticCollection(
    "ai-error-translator",
  );

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.text = "$(robot) AI Ready";
  statusBar.show();

  const setKeyCommand = vscode.commands.registerCommand(
    "aiTranslator.setApiKey",
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your cloud API key",
        password: true,
      });
      if (key) {
        await context.secrets.store("cloud_api_key", key);
        vscode.window.showInformationMessage("Cloud API key saved securely.");
      }
    },
  );

  const configureCommand = vscode.commands.registerCommand(
    "aiTranslator.configure",
    () => runConfigureWizard(),
  );

  const pickLocalModelCommand = vscode.commands.registerCommand(
    "aiTranslator.pickLocalModel",
    () => runPickLocalModel(),
  );

  const hoverProvider = vscode.languages.registerHoverProvider("*", {
    provideHover(document, position, token) {
      const diagnostics = vscode.languages.getDiagnostics(document.uri);
      const error = pickBestDiagnosticAt(diagnostics, position);
      if (!error) return null;

      const cfg = getTranslatorConfig();
      const cacheKey = buildCacheKey(document, error, cfg);

      debugChannel.appendLine(`[hover] key=${cacheKey.substring(0, 80)}`);
      debugChannel.appendLine(`[hover] cache size=${explanationCache.size}, hit=${explanationCache.has(cacheKey)}`);

      if (explanationCache.has(cacheKey)) {
        upsertAiDiagnostic(document.uri, error, explanationCache.get(cacheKey)!);
        debugChannel.appendLine(`[hover] returning cached result`);
        return createHover(explanationCache.get(cacheKey)!, error.range);
      }

      // Fire background fetch to populate cache
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());

      const prompt = buildPrompt(document, error, cfg.contextLines);

      statusBar.text = "$(sync~spin) AI Thinking...";
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );

      debugChannel.appendLine(`[fetch] starting fetch, provider=${cfg.provider}, model=${cfg.localModel}`);
      inFlightRequests.add(cacheKey);

      fetchExplanation(prompt, cfg, context, ac.signal).then(
        (explanation) => {
          debugChannel.appendLine(`[fetch] success, cancelled=${token.isCancellationRequested}`);
          if (token.isCancellationRequested) return;
          explanationCache.set(cacheKey, explanation);
          upsertAiDiagnostic(document.uri, error, explanation);
          debugChannel.appendLine(`[fetch] cached. Cache size now=${explanationCache.size}`);
          resetStatusIdle();
        },
        (err: unknown) => {
          debugChannel.appendLine(`[fetch] error: ${getErrorMessage(err)}`);
          if (isAbortError(err) || token.isCancellationRequested) {
            resetStatusIdle();
            return;
          }
          statusBar.text = "$(error) AI Error";
          statusBar.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.errorBackground",
          );
          const errorText = `AI Error: ${getErrorMessage(err)}`;
          explanationCache.set(cacheKey, `**AI Error:** ${escapeMarkdown(getErrorMessage(err))}`);
          upsertAiDiagnostic(document.uri, error, errorText);
        },
      ).finally(() => {
        inFlightRequests.delete(cacheKey);
      });

      return null;
    },
  });

  const diagnosticsChangeSub = vscode.languages.onDidChangeDiagnostics((event) => {
    for (const uri of event.uris) {
      prefetchExplanationsForUri(uri, context);
    }
  });

  const activeEditorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    prefetchExplanationsForUri(editor.document.uri, context);
  });

  const openDocSub = vscode.workspace.onDidOpenTextDocument((document) => {
    prefetchExplanationsForUri(document.uri, context);
  });

  const initialEditor = vscode.window.activeTextEditor;
  if (initialEditor) {
    prefetchExplanationsForUri(initialEditor.document.uri, context);
  }

  context.subscriptions.push(
    hoverProvider,
    statusBar,
    debugChannel,
    aiDiagnosticCollection,
    diagnosticsChangeSub,
    activeEditorSub,
    openDocSub,
    setKeyCommand,
    configureCommand,
    pickLocalModelCommand,
  );
}

function resetStatusIdle(): void {
  statusBar.text = "$(robot) AI Ready";
  statusBar.backgroundColor = undefined;
}

type ModeQuickPick = vscode.QuickPickItem & { readonly mode: "local" | "cloud" };
type CloudUrlQuickPick = vscode.QuickPickItem & { readonly presetUrl: string };

function runConfigureWizard(): Thenable<void> {
  return (async () => {
    const mode = await vscode.window.showQuickPick<ModeQuickPick>(
      [
        {
          label: "$(server-process) Local (Ollama)",
          mode: "local",
        },
        {
          label: "$(cloud) Cloud (OpenAI-compatible)",
          mode: "cloud",
        },
      ],
      { placeHolder: "Choose how AI Error Translator connects to the model" },
    );
    if (!mode) return;

    const config = vscode.workspace.getConfiguration("aiTranslator");

    if (mode.mode === "local") {
      await config.update(
        "provider",
        "Ollama (Local)",
        vscode.ConfigurationTarget.Global,
      );
      const ollamaUrl =
        (await vscode.window.showInputBox({
          prompt: "Ollama base URL (leave empty to keep current)",
          value: config.get<string>("ollamaBaseUrl") ?? "http://localhost:11434",
        })) ?? undefined;
      if (ollamaUrl !== undefined && ollamaUrl.trim()) {
        await config.update(
          "ollamaBaseUrl",
          ollamaUrl.trim(),
          vscode.ConfigurationTarget.Global,
        );
      }
      const pickModel = await vscode.window.showInformationMessage(
        "Choose an installed model from Ollama?",
        "Pick model",
        "Skip",
      );
      if (pickModel === "Pick model") {
        await runPickLocalModel();
      }
      vscode.window.showInformationMessage(
        'Local mode configured. Adjust settings anytime under "AI Error Translator".',
      );
      return;
    }

    await config.update(
      "provider",
      "Cloud (OpenAI-Compatible)",
      vscode.ConfigurationTarget.Global,
    );

    const preset = await vscode.window.showQuickPick<CloudUrlQuickPick>(
      CLOUD_PRESETS.map((p) => ({
        label: p.label,
        description: p.url || undefined,
        presetUrl: p.url,
      })),
      { placeHolder: "Pick a common API base URL or choose Custom" },
    );
    if (!preset) return;

    let baseUrl = preset.presetUrl;
    if (preset.presetUrl === "__custom__") {
      baseUrl =
        (await vscode.window.showInputBox({
          prompt: "OpenAI-compatible API base URL (without /chat/completions)",
          value: config.get<string>("cloudBaseUrl"),
        })) ?? "";
      if (!baseUrl.trim()) return;
      baseUrl = baseUrl.trim();
    } else if (preset.presetUrl === "") {
      baseUrl =
        (await vscode.window.showInputBox({
          prompt: "Enter base URL for your provider",
        })) ?? "";
      if (!baseUrl.trim()) return;
      baseUrl = baseUrl.trim();
    } else {
      await config.update(
        "cloudBaseUrl",
        preset.presetUrl,
        vscode.ConfigurationTarget.Global,
      );
    }

    if (preset.presetUrl === "__custom__" || preset.presetUrl === "") {
      await config.update(
        "cloudBaseUrl",
        baseUrl,
        vscode.ConfigurationTarget.Global,
      );
    }

    await vscode.commands.executeCommand("aiTranslator.setApiKey");

    const model =
      (await vscode.window.showInputBox({
        prompt: "Cloud model ID (e.g. gpt-4o-mini, llama-3.3-70b-versatile)",
        value: config.get<string>("cloudModel"),
      })) ?? undefined;
    if (model?.trim()) {
      await config.update(
        "cloudModel",
        model.trim(),
        vscode.ConfigurationTarget.Global,
      );
    }

    vscode.window.showInformationMessage(
      "Cloud mode configured. You can fine-tune URL, model, and optional headers in Settings.",
    );
  })();
}

async function runPickLocalModel(): Promise<void> {
  const cfg = getTranslatorConfig();
  const base = normalizeBaseUrl(cfg.ollamaBaseUrl);
  const tagsUrl = `${base}/api/tags`;

  try {
    const res = await fetch(tagsUrl, { method: "GET" });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Could not list models (${res.status}): ${truncate(raw, 200)}`);
    }
    let parsed: { models?: Array<{ name?: string }> };
    try {
      parsed = JSON.parse(raw) as { models?: Array<{ name?: string }> };
    } catch {
      throw new Error(`Ollama tags response was not JSON: ${truncate(raw, 200)}`);
    }
    const names =
      parsed.models?.map((m) => m.name).filter((n): n is string => !!n) ?? [];
    if (names.length === 0) {
      vscode.window.showWarningMessage(
        "Ollama returned no models. Pull one with `ollama pull <model>`.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(names, {
      placeHolder: "Select a local model",
    });
    if (!picked) return;
    await vscode.workspace
      .getConfiguration("aiTranslator")
      .update("localModel", picked, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Local model set to ${picked}.`);
  } catch (e: unknown) {
    vscode.window.showErrorMessage(getErrorMessage(e));
  }
}

function pickBestDiagnosticAt(
  diagnostics: readonly vscode.Diagnostic[],
  position: vscode.Position,
): vscode.Diagnostic | undefined {
  const containing = diagnostics.filter((d) => d.range.contains(position));
  if (containing.length === 0) return undefined;
  if (containing.length === 1) return containing[0];

  const severityRank = (s: vscode.DiagnosticSeverity) => {
    switch (s) {
      case vscode.DiagnosticSeverity.Error:
        return 0;
      case vscode.DiagnosticSeverity.Warning:
        return 1;
      case vscode.DiagnosticSeverity.Information:
        return 2;
      default:
        return 3;
    }
  };

  const rangeSize = (d: vscode.Diagnostic) =>
    documentOffsetAt(d.range.end) - documentOffsetAt(d.range.start);

  containing.sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return rangeSize(a) - rangeSize(b);
  });

  return containing[0];
}

function documentOffsetAt(pos: vscode.Position): number {
  return pos.line * 1_000_000 + pos.character;
}

function createHover(text: string, range?: vscode.Range): vscode.Hover {
  const md = new vscode.MarkdownString(`### AI Explanation\n\n${text}`);
  md.isTrusted = false;
  return range ? new vscode.Hover(md, range) : new vscode.Hover(md);
}

function upsertAiDiagnostic(
  uri: vscode.Uri,
  original: vscode.Diagnostic,
  explanation: string,
): void {
  const uriKey = uri.toString();
  const fingerprint = diagnosticFingerprint(original);
  const existingForUri = aiDiagnosticsByUri.get(uriKey) ?? new Map();

  const explanationText = truncate(explanation.replace(/\s+/g, " ").trim(), 700);
  const message = `AI explanation:\n${explanationText}`;

  const aiDiagnostic = new vscode.Diagnostic(
    original.range,
    message,
    vscode.DiagnosticSeverity.Information,
  );
  aiDiagnostic.source = "AI Error Translator";
  aiDiagnostic.code = "AI-EXPLAIN";

  existingForUri.set(fingerprint, aiDiagnostic);
  aiDiagnosticsByUri.set(uriKey, existingForUri);
  aiDiagnosticCollection.set(uri, Array.from(existingForUri.values()));
}

function prefetchExplanationsForUri(
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
): void {
  const document = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  if (!document) return;

  const diagnostics = vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, 6);
  if (diagnostics.length === 0) return;

  const cfg = getTranslatorConfig();
  for (const diagnostic of diagnostics) {
    const cacheKey = buildCacheKey(document, diagnostic, cfg);
    if (explanationCache.has(cacheKey) || inFlightRequests.has(cacheKey)) {
      continue;
    }

    const prompt = buildPrompt(document, diagnostic, cfg.contextLines);
    const ac = new AbortController();
    inFlightRequests.add(cacheKey);
    debugChannel.appendLine(`[prefetch] start for ${uri.toString()}`);

    fetchExplanation(prompt, cfg, context, ac.signal)
      .then((explanation) => {
        explanationCache.set(cacheKey, explanation);
        upsertAiDiagnostic(uri, diagnostic, explanation);
        debugChannel.appendLine(`[prefetch] cached for ${uri.toString()}`);
      })
      .catch((err: unknown) => {
        const errorText = `AI Error: ${getErrorMessage(err)}`;
        explanationCache.set(
          cacheKey,
          `**AI Error:** ${escapeMarkdown(getErrorMessage(err))}`,
        );
        upsertAiDiagnostic(uri, diagnostic, errorText);
        debugChannel.appendLine(`[prefetch] error for ${uri.toString()}: ${getErrorMessage(err)}`);
      })
      .finally(() => {
        inFlightRequests.delete(cacheKey);
      });
  }
}

function diagnosticFingerprint(diagnostic: vscode.Diagnostic): string {
  const rangeKey = `${diagnostic.range.start.line}:${diagnostic.range.start.character}-${diagnostic.range.end.line}:${diagnostic.range.end.character}`;
  const code =
    typeof diagnostic.code === "string" || typeof diagnostic.code === "number"
      ? String(diagnostic.code)
      : (diagnostic.code?.value ?? "").toString();
  return [
    rangeKey,
    diagnostic.source ?? "",
    code,
    String(diagnostic.severity),
    diagnostic.message,
  ].join("|");
}

function getTranslatorConfig(): TranslatorConfig {
  const config = vscode.workspace.getConfiguration("aiTranslator");
  let provider = (config.get<string>("provider") ??
    "Ollama (Local)") as string;
  if (provider === "Groq (Cloud)") {
    provider = "Cloud (OpenAI-Compatible)";
  }
  const normalized = (
    provider === "Cloud (OpenAI-Compatible)" ? provider : "Ollama (Local)"
  ) as ProviderType;

  const headersRaw = config.get<Record<string, unknown>>("cloudHeaders");
  const cloudHeaders: Record<string, string> = {};
  if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
    for (const [k, v] of Object.entries(headersRaw)) {
      if (typeof v === "string") {
        cloudHeaders[k] = v;
      }
    }
  }

  return {
    provider: normalized,
    localModel: config.get<string>("localModel") ?? "qwen2.5-coder:1.5b",
    cloudModel:
      config.get<string>("cloudModel") ?? "llama-3.3-70b-versatile",
    cloudBaseUrl:
      config.get<string>("cloudBaseUrl") ?? "https://api.groq.com/openai/v1",
    ollamaBaseUrl:
      config.get<string>("ollamaBaseUrl") ?? "http://localhost:11434",
    debounceMs: Math.max(0, config.get<number>("debounceMs") ?? 120),
    contextLines: Math.max(
      0,
      Math.min(20, config.get<number>("contextLines") ?? 4),
    ),
    cloudHeaders,
  };
}

function buildCacheKey(
  document: vscode.TextDocument,
  error: vscode.Diagnostic,
  cfg: TranslatorConfig,
): string {
  const code =
    typeof error.code === "string" || typeof error.code === "number"
      ? String(error.code)
      : (error.code?.value ?? "").toString();
  const model = isLocalProvider(cfg.provider) ? cfg.localModel : cfg.cloudModel;
  const endpoint = isLocalProvider(cfg.provider)
    ? normalizeBaseUrl(cfg.ollamaBaseUrl)
    : normalizeBaseUrl(cfg.cloudBaseUrl);
  const rangeKey = `${error.range.start.line}:${error.range.start.character}-${error.range.end.line}:${error.range.end.character}`;

  return [
    cfg.provider,
    model,
    endpoint,
    document.uri.toString(),
    error.source ?? "",
    code,
    String(error.severity),
    rangeKey,
    error.message,
  ].join("|");
}

function isLocalProvider(provider: ProviderType): boolean {
  return provider === "Ollama (Local)";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildPrompt(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  contextLines: number,
): string {
  const sev = diagnosticSeverityLabel(diagnostic.severity);
  const start = diagnostic.range.start;
  const code =
    typeof diagnostic.code === "string" || typeof diagnostic.code === "number"
      ? String(diagnostic.code)
      : diagnostic.code?.value != null
        ? String(diagnostic.code.value)
        : "";
  const rel = vscode.workspace.asRelativePath(document.uri, false);
  const snippet = extractSnippet(document, diagnostic.range, contextLines);

  const parts = [
    "Explain this compiler or linter diagnostic in plain English. Say what likely caused it and concrete steps to fix it. Keep the answer concise.",
    "",
    `File: ${rel}`,
    `Location: line ${start.line + 1}, column ${start.character + 1}`,
    `Severity: ${sev}`,
    diagnostic.source ? `Source: ${diagnostic.source}` : null,
    code ? `Code: ${code}` : null,
    "",
    "Message:",
    diagnostic.message,
    "",
    "Editor context (line numbers are 1-based):",
    snippet,
  ];

  return parts.filter((p) => p != null).join("\n");
}

function diagnosticSeverityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function extractSnippet(
  document: vscode.TextDocument,
  range: vscode.Range,
  pad: number,
): string {
  const startLine = Math.max(0, range.start.line - pad);
  const endLine = Math.min(document.lineCount - 1, range.end.line + pad);
  const lines: string[] = [];
  const singleLine =
    range.start.line === range.end.line;
  for (let i = startLine; i <= endLine; i++) {
    const line = document.lineAt(i);
    const prefix = `${i + 1}: `;
    lines.push(prefix + line.text);
    if (singleLine && i === range.start.line) {
      const caretSpaces = " ".repeat(
        prefix.length + range.start.character,
      );
      const carets =
        "^".repeat(
          Math.max(1, range.end.character - range.start.character),
        );
      lines.push(caretSpaces + carets);
    }
  }
  return lines.join("\n");
}

async function fetchExplanation(
  prompt: string,
  cfg: TranslatorConfig,
  context: vscode.ExtensionContext,
  signal: AbortSignal,
): Promise<string> {
  if (isLocalProvider(cfg.provider)) {
    return callOllama(prompt, cfg.localModel, cfg.ollamaBaseUrl, signal);
  }

  const apiKey = await context.secrets.get("cloud_api_key");
  if (!apiKey) {
    throw new Error(
      "Missing cloud API key. Run 'AI Translator: Enter Cloud API Key' or use 'AI Translator: Configure'.",
    );
  }

  return callCloud(
    prompt,
    apiKey,
    cfg.cloudBaseUrl,
    cfg.cloudModel,
    cfg.cloudHeaders,
    signal,
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === "AbortError" ||
      /aborted/i.test(err.message)
    );
  }
  return false;
}

function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

async function callOllama(
  prompt: string,
  model: string,
  ollamaBaseUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const base = normalizeBaseUrl(ollamaBaseUrl);
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
    signal,
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `Ollama request failed (${res.status}): ${truncate(raw, 400)}`,
    );
  }

  let data: { response?: string };
  try {
    data = JSON.parse(raw) as { response?: string };
  } catch {
    throw new Error(`Ollama returned non-JSON: ${truncate(raw, 200)}`);
  }

  if (!data.response) {
    throw new Error("Ollama returned an empty response.");
  }

  return data.response;
}

async function callCloud(
  prompt: string,
  key: string,
  baseUrl: string,
  model: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
    Authorization: `Bearer ${key}`,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });

  const raw = await res.text();
  let data: {
    error?: { message?: string };
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error(
      `Cloud API returned non-JSON (${res.status}): ${truncate(raw, 400)}`,
    );
  }

  if (!res.ok) {
    const apiMessage = data.error?.message ?? truncate(raw, 300);
    throw new Error(`Cloud API request failed (${res.status}): ${apiMessage}`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Cloud API returned an empty response.");
  }

  return content;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
