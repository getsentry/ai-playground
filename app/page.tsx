"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Helper: split an assistant message's parts into steps at step-start
// boundaries so we can render each step as its own bubble.
// ---------------------------------------------------------------------------

type MessagePart = UIMessage["parts"][number];

function splitIntoSteps(parts: MessagePart[]): MessagePart[][] {
  const steps: MessagePart[][] = [];
  let current: MessagePart[] = [];

  for (const part of parts) {
    if (part.type === "step-start" && current.length > 0) {
      steps.push(current);
      current = [];
    }
    // Don't include the step-start marker itself in the rendered parts
    if (part.type !== "step-start") {
      current.push(part);
    }
  }
  if (current.length > 0) {
    steps.push(current);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Prompt card data
// ---------------------------------------------------------------------------

interface PromptCard {
  prompt: string;
  docUrl?: string;
}

const FEATURED_PROMPTS: PromptCard[] = [
  {
    prompt: "Show me the top 5 issues in my environment and how to fix them",
    docUrl: "https://docs.sentry.io/product/issues/",
  },
  {
    prompt: "Show me the slowest database calls in my projects",
    docUrl: "https://docs.sentry.io/product/performance/queries/",
  },
  {
    prompt: "Which transactions have the worst performance this week?",
    docUrl: "https://docs.sentry.io/product/performance/",
  },
  {
    prompt: "Did my last release introduce any new errors?",
    docUrl: "https://docs.sentry.io/product/releases/",
  },
  {
    prompt: "Which issues are affecting the most users right now?",
    docUrl: "https://docs.sentry.io/product/issues/",
  },
];

const MORE_PROMPTS: PromptCard[] = [
  {
    prompt:
      "Use Seer to find the root cause of the most frequent error in my project",
    docUrl: "https://docs.sentry.io/product/issues/issue-details/seer/",
  },
  {
    prompt: "Are there any issues that keep regressing across releases?",
    docUrl: "https://docs.sentry.io/product/issues/states-triage/",
  },
  {
    prompt: "What does request throughput look like over the past day?",
    docUrl: "https://docs.sentry.io/product/performance/",
  },
  {
    prompt: "What is my crash-free session rate across all projects?",
    docUrl: "https://docs.sentry.io/product/releases/health/",
  },
  {
    prompt: "Show me every issue that was first seen today",
    docUrl: "https://docs.sentry.io/product/issues/",
  },
  {
    prompt: "Summarize all the alerts that fired in the last 24 hours",
    docUrl: "https://docs.sentry.io/product/alerts/",
  },
  {
    prompt:
      "Compare error rates between my last two releases — better or worse?",
    docUrl: "https://docs.sentry.io/product/releases/",
  },
  {
    prompt: "Show me all unhandled exceptions from the past 24 hours",
    docUrl: "https://docs.sentry.io/product/issues/",
  },
  {
    prompt: "How are my Core Web Vitals? Any pages with poor LCP or CLS?",
    docUrl: "https://docs.sentry.io/product/performance/web-vitals/",
  },
  {
    prompt: "Which endpoints have the highest error rate this week?",
    docUrl: "https://docs.sentry.io/product/performance/",
  },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const { messages, sendMessage, status, stop, error, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onError: (err) => console.error("Chat error:", err),
  });

  const [input, setInput] = useState("");

  // Derived: is the model busy?
  const isBusy = status === "submitted" || status === "streaming";

  // -------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/status");
        const data = await res.json();
        setIsConnected(data.connected);
      } catch {
        setIsConnected(false);
      } finally {
        setIsCheckingAuth(false);
      }
    };
    checkAuth();

    // Handler shared by both postMessage and BroadcastChannel
    const handleOAuthResult = (data: { type?: string; success?: boolean }) => {
      if (data?.type === "sentry-oauth-result") {
        setIsConnecting(false);
        if (data.success) {
          setIsConnected(true);
        }
      }
    };

    // Strategy 1: postMessage from popup (works if window.opener survived)
    const onMessage = (event: MessageEvent) => handleOAuthResult(event.data);
    window.addEventListener("message", onMessage);

    // Strategy 2: BroadcastChannel (same-origin, works even without opener)
    let bc: BroadcastChannel | undefined;
    try {
      bc = new BroadcastChannel("sentry-oauth");
      bc.onmessage = (event: MessageEvent) => handleOAuthResult(event.data);
    } catch {
      // BroadcastChannel not supported — postMessage + poll fallback
    }

    return () => {
      window.removeEventListener("message", onMessage);
      bc?.close();
    };
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus chat input when sheet opens
  useEffect(() => {
    if (isChatOpen) {
      setTimeout(() => chatInputRef.current?.focus(), 400);
    }
  }, [isChatOpen]);

  // -------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------

  const openConnectPopup = () => {
    setIsConnecting(true);
    const w = 900;
    const h = 800;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(
      "/api/auth/connect",
      "sentry-oauth",
      `width=${w},height=${h},left=${left},top=${top},popup=yes`
    );

    if (popup) {
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          setTimeout(async () => {
            try {
              const res = await fetch("/api/auth/status");
              const data = await res.json();
              if (data.connected) {
                setIsConnected(true);
              }
            } catch {
              // ignore
            } finally {
              setIsConnecting(false);
            }
          }, 300);
        }
      }, 500);
    }
  };

  const handleDisconnect = async () => {
    try {
      await fetch("/api/auth/disconnect", { method: "POST" });
    } catch {
      // ignore
    }
    setIsConnected(false);
    setIsChatOpen(false);
    setMessages([]);
    setInput("");
  };

  const openChatWithPrompt = useCallback(
    (prompt: string) => {
      if (!isConnected || isBusy) return;

      if (!isChatOpen) {
        setIsChatOpen(true);
        setTimeout(() => {
          sendMessage({ text: prompt });
        }, 400);
      } else {
        sendMessage({ text: prompt });
      }
    },
    [isConnected, isBusy, isChatOpen, sendMessage]
  );

  const handleLandingSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !isConnected || isBusy) return;
    const text = input;
    setInput("");
    openChatWithPrompt(text);
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || status !== "ready") return;
    sendMessage({ text: input });
    setInput("");
  };

  const toggleChat = () => {
    if (isChatOpen) {
      setIsChatOpen(false);
      setTimeout(() => {
        setMessages([]);
        setInput("");
      }, 350);
    } else {
      setIsChatOpen(true);
    }
  };

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  const cardsDisabled = !isConnected || isBusy;

  // Shared chat messages JSX (used by both desktop and mobile)
  const chatMessages = (
    <div className="space-y-4">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-accent-dim/20 px-4 py-3 text-foreground">
                <div className="chat-markdown text-sm leading-relaxed">
                  {message.parts.map((part, i) =>
                    part.type === "text" ? (
                      <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
                        {part.text}
                      </ReactMarkdown>
                    ) : null
                  )}
                </div>
              </div>
            </div>
          );
        }

        const steps = splitIntoSteps(message.parts);

        return steps.map((stepParts, stepIndex) => {
          const hasContent = stepParts.some(
            (p) =>
              p.type === "text" ||
              p.type === "reasoning" ||
              p.type === "dynamic-tool"
          );
          if (!hasContent) return null;

          const textContent = stepParts
            .filter(
              (p): p is Extract<typeof p, { type: "text" }> =>
                p.type === "text"
            )
            .map((p) => p.text)
            .join("\n\n");

          return (
            <div
              key={`${message.id}-step-${stepIndex}`}
              className="flex justify-start"
            >
              <div className="group/msg relative max-w-[85%] rounded-lg bg-card px-4 py-3 text-foreground">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-accent">
                    sentry
                  </span>
                  {textContent && <CopyButton text={textContent} />}
                </div>
                <div className="chat-markdown text-sm leading-relaxed">
                  {stepParts.map((part, index) => {
                    if (part.type === "text") {
                      return (
                        <ReactMarkdown
                          key={index}
                          remarkPlugins={[remarkGfm]}
                        >
                          {part.text}
                        </ReactMarkdown>
                      );
                    }
                    if (part.type === "reasoning") {
                      return (
                        <details
                          key={index}
                          className="my-2 rounded border border-border bg-background p-2"
                        >
                          <summary className="cursor-pointer text-xs text-muted">
                            Reasoning
                          </summary>
                          <pre className="mt-2 whitespace-pre-wrap text-xs text-muted">
                            {part.text}
                          </pre>
                        </details>
                      );
                    }
                    if (part.type === "dynamic-tool") {
                      return (
                        <ToolCallBlock
                          key={index}
                          toolName={part.toolName}
                          state={part.state}
                          input={
                            "input" in part ? part.input : undefined
                          }
                          output={
                            "output" in part ? part.output : undefined
                          }
                          errorText={
                            "errorText" in part
                              ? (part.errorText as string)
                              : undefined
                          }
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            </div>
          );
        });
      })}

      {/* Loading */}
      {isBusy &&
        messages.length > 0 &&
        messages[messages.length - 1]?.role === "user" && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1 rounded-lg bg-card px-4 py-3 text-sm text-muted">
              <span className="loading-dot">.</span>
              <span className="loading-dot">.</span>
              <span className="loading-dot">.</span>
            </div>
          </div>
        )}

      {/* Error */}
      {error && (
        <div className="flex justify-start">
          <div className="rounded-lg border border-red-900/50 bg-red-950/20 px-4 py-3 text-sm text-red-400">
            Error: {error.message || "Something went wrong."}
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );

  // Shared chat input JSX
  const chatInput = (
    <div className="border-t border-border px-4 py-3 md:px-5 md:py-4">
      {isBusy ? (
        <button
          onClick={() => stop()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted transition-colors hover:border-red-900/50 hover:text-red-400"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="currentColor"
          >
            <rect x="2" y="2" width="10" height="10" rx="2" />
          </svg>
          Stop generating
        </button>
      ) : (
        <form
          onSubmit={handleChatSubmit}
          className="flex items-center gap-3"
        >
          <input
            ref={chatInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Sentry something..."
            className="flex-1 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground placeholder-muted outline-none transition-colors focus:border-accent-dim"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg bg-accent-dim px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-accent-dim"
          >
            Send
          </button>
        </form>
      )}
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* ============================================================= */}
      {/* Main content area — shrinks when chat opens (desktop)           */}
      {/* ============================================================= */}
      <div
        className="relative z-10 flex min-w-0 flex-1 snap-y snap-mandatory flex-col overflow-y-auto scroll-smooth transition-all duration-350 ease-in-out"
      >
        {/* Top bar with chat toggle */}
        <header className="sticky top-0 z-20 flex items-center justify-end px-4 py-3 md:px-6 md:py-4">
          {isConnected && (
            <button
              onClick={toggleChat}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-muted transition-colors hover:border-accent-dim/50 hover:text-foreground"
              title={isChatOpen ? "Close chat" : "Open chat"}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </header>

        {/* =========================================================== */}
        {/* First page — hero, input, featured prompts, arrow            */}
        {/* =========================================================== */}
        <div className="flex min-h-[calc(100vh-3.5rem)] snap-start flex-col items-center px-4 md:px-6">
          <div className="flex w-full max-w-6xl flex-1 flex-col items-center justify-center">
            <h1 className="mb-4 text-center text-4xl font-bold tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
              Talk Sentry to me<span className="text-accent">...</span>
            </h1>

            {/* Connect button */}
            <div className="mb-8 md:mb-10">
              {isCheckingAuth ? (
                <button
                  disabled
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-6 py-3 text-sm font-medium text-muted opacity-60"
                >
                  Checking connection...
                </button>
              ) : isConnected ? (
                <button
                  onClick={handleDisconnect}
                  className="group inline-flex items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-4 py-2 text-sm text-emerald-400 transition-colors hover:border-red-900/50 hover:bg-red-950/20 hover:text-red-400"
                >
                  <div className="h-2 w-2 rounded-full bg-emerald-500 transition-colors group-hover:bg-red-500" />
                  <span className="group-hover:hidden">Connected to Sentry</span>
                  <span className="hidden group-hover:inline">Disconnect</span>
                </button>
              ) : isConnecting ? (
                <button
                  disabled
                  className="inline-flex items-center gap-2 rounded-lg border border-accent-dim/50 bg-accent-dim/10 px-6 py-3 text-sm font-medium text-accent transition-colors"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="animate-spin"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeDasharray="28"
                      strokeDashoffset="8"
                      strokeLinecap="round"
                    />
                  </svg>
                  Connecting...
                </button>
              ) : (
                <button
                  onClick={openConnectPopup}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent-dim px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="opacity-80"
                  >
                    <path
                      d="M8 1a7 7 0 100 14A7 7 0 008 1zM6.5 5a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zM5 9.5C5 8.67 6.34 8 8 8s3 .67 3 1.5V11H5V9.5z"
                      fill="currentColor"
                    />
                  </svg>
                  Connect to Sentry
                </button>
              )}
            </div>

            {/* Input bar */}
            <form
              onSubmit={handleLandingSubmit}
              className="mb-10 flex w-full max-w-2xl items-center gap-3 md:mb-14"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={!isConnected || isBusy}
                placeholder={
                  isConnected
                    ? isBusy
                      ? "Waiting for response..."
                      : "Ask Sentry anything..."
                    : "Connect to Sentry first..."
                }
                className="flex-1 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground placeholder-muted outline-none transition-colors focus:border-accent-dim disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!isConnected || !input.trim() || isBusy}
                className="rounded-lg bg-accent-dim px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-accent-dim"
              >
                Send
              </button>
            </form>

            {/* Featured prompts */}
            <div className="grid w-full max-w-6xl grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4 lg:grid-cols-5">
              {FEATURED_PROMPTS.map((card) => (
                <PromptCardButton
                  key={card.prompt}
                  card={card}
                  disabled={cardsDisabled}
                  onClick={() => openChatWithPrompt(card.prompt)}
                />
              ))}
            </div>
          </div>

          {/* Scroll-down arrow */}
          <div className="flex flex-col items-center gap-1 pb-6 pt-4 text-muted/60">
            <span className="text-xs">more prompts</span>
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              className="bounce-arrow"
            >
              <path
                d="M10 4v12m0 0l-4-4m4 4l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* =========================================================== */}
        {/* Second page — prompt library                                 */}
        {/* =========================================================== */}
        <div className="flex min-h-screen snap-start flex-col items-center justify-center px-4 md:px-6">
          <div className="w-full max-w-6xl">
            <h2 className="mb-6 text-sm font-medium uppercase tracking-widest text-muted md:mb-8">
              Prompt Library
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4 lg:grid-cols-5">
              {MORE_PROMPTS.map((card) => (
                <PromptCardButton
                  key={card.prompt}
                  card={card}
                  disabled={cardsDisabled}
                  onClick={() => openChatWithPrompt(card.prompt)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================= */}
      {/* Desktop chat panel — in-flow, pushes content left              */}
      {/* Hidden on mobile (md: and up only)                             */}
      {/* ============================================================= */}
      <div
        style={{ width: isChatOpen ? "42rem" : "0" }}
        className="relative z-10 hidden h-full flex-shrink-0 flex-col overflow-hidden border-l border-border bg-background transition-[width] duration-350 ease-in-out md:flex"
      >
        <div className="flex h-full w-[42rem] flex-col">
          {/* Header */}
          <header className="flex items-center justify-between border-b border-border px-5 py-4">
            <button
              onClick={toggleChat}
              className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M12 4L4 12M4 4l8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              Close
            </button>
            <span className="text-xs text-muted">Sentry MCP</span>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-muted">Connected</span>
            </div>
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-6">
            {chatMessages}
          </div>

          {/* Input */}
          {chatInput}
        </div>
      </div>

      {/* ============================================================= */}
      {/* Mobile chat sheet — full-screen overlay (below md)             */}
      {/* ============================================================= */}
      <div
        className={`fixed inset-0 z-50 flex flex-col bg-background transition-transform duration-300 ease-in-out md:hidden ${
          isChatOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header with back button */}
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <button
            onClick={toggleChat}
            className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3L5 8l5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back
          </button>
          <span className="text-xs text-muted">Sentry MCP</span>
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-xs text-muted">Connected</span>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {chatMessages}
        </div>

        {/* Input */}
        {chatInput}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy button — appears on hover for assistant messages
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted opacity-0 transition-opacity hover:text-foreground group-hover/msg:opacity-100"
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.5L5 9l4.5-6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Copied</span>
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect
              x="4"
              y="4"
              width="6.5"
              height="6.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M8 4V2.5A1.5 1.5 0 006.5 1h-4A1.5 1.5 0 001 2.5v4A1.5 1.5 0 002.5 8H4"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tool call block — spinner while running, expandable to see results
// ---------------------------------------------------------------------------

function ToolCallBlock({
  toolName,
  state,
  input,
  output,
  errorText,
}: {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const isError = state === "output-error";

  const label = isRunning
    ? toolName
    : isDone
      ? toolName
      : isError
        ? `${toolName} — failed`
        : toolName;

  const hasDetails = isDone || isError || input != null;

  return (
    <details className={`tool-call-block group my-2 rounded border border-border bg-background transition-opacity ${isDone ? "opacity-60" : ""}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-xs text-muted select-none [&::-webkit-details-marker]:hidden">
        {isRunning ? (
          <span className="tool-spinner" />
        ) : isError ? (
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-red-900/40 text-red-400">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M6 2L2 6M2 2l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
        ) : (
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-900/40 text-emerald-400">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1.5 4.5L3 6l3.5-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}

        <span className="flex-1 truncate">{label}</span>

        {hasDetails && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="flex-shrink-0 transition-transform group-open:rotate-90"
          >
            <path
              d="M4.5 2.5l3 3.5-3 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </summary>

      {hasDetails && (
        <div className="border-t border-border px-3 py-2.5">
          {input != null && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted/60">
                Input
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-card p-2 text-xs text-muted">
                {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {isDone && output != null && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted/60">
                Output
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-card p-2 text-xs text-muted">
                {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
          {isError && errorText && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-red-400/80">
                Error
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-950/20 p-2 text-xs text-red-400">
                {errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Prompt card
// ---------------------------------------------------------------------------

function PromptCardButton({
  card,
  disabled,
  onClick,
}: {
  card: PromptCard;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex min-h-[6rem] flex-col justify-between rounded-lg border border-border bg-card p-4 text-left transition-all hover:border-accent-dim/50 hover:bg-card-hover disabled:pointer-events-none disabled:opacity-40 md:min-h-[8rem] md:p-6"
    >
      <p className="mb-2 text-sm leading-snug text-foreground group-hover:text-accent md:mb-3 md:text-base">
        {card.prompt}
      </p>
      {card.docUrl && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            window.open(card.docUrl, "_blank");
          }}
          className="mt-auto text-xs text-accent/60 transition-colors hover:text-accent"
        >
          docs &rarr;
        </span>
      )}
    </button>
  );
}
