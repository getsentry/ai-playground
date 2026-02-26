import {
  convertToModelMessages,
  streamText,
  UIMessage,
  stepCountIs,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { cookies } from "next/headers";
import { getSession } from "@/app/lib/mcp-auth";
import * as Sentry from "@sentry/nextjs";

export const maxDuration = 60;

export async function POST(req: Request) {
  let mcpClient: MCPClient | undefined;

  try {
    const { messages }: { messages: UIMessage[] } = await req.json();

    // Get session tokens
    const cookieStore = await cookies();
    const sessionId = cookieStore.get("mcp_session")?.value;
    const session = sessionId ? getSession(sessionId) : null;

    if (!session?.tokens?.access_token) {
      return new Response(
        JSON.stringify({ error: "Not authenticated with Sentry" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Link all AI spans in this request to the user's conversation
    Sentry.setConversationId(sessionId!);

    const sentryMcpUrl =
      process.env.SENTRY_MCP_URL || "https://mcp.sentry.dev/mcp";

    // Create MCP client with the stored OAuth token
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: sentryMcpUrl,
        headers: {
          Authorization: `Bearer ${session.tokens.access_token}`,
        },
      },
    });

    // Get all tools from the Sentry MCP server
    const tools = await mcpClient.tools();

    const result = streamText({
      model: anthropic("claude-haiku-4-6"),
      system: `You are a strict Sentry observability assistant. Your ONLY purpose is to help users query and understand their Sentry data using the available MCP tools. You must NEVER answer questions unrelated to Sentry or application observability.

RULES:
1. Every valid user request MUST result in one or more Sentry tool calls. If a question can be answered by calling a Sentry tool, call it. Do not answer from memory alone.
2. You may ONLY discuss topics directly related to Sentry and application observability: errors, issues, performance, traces, releases, alerts, dashboards, projects, teams, replays, crons, metrics, AI monitoring, and MCP.
3. If a user asks about anything outside of Sentry or observability (general coding questions, non-Sentry products, small talk, math, trivia, creative writing, etc.), politely decline and redirect them. Example: "I can only help with Sentry observability data. Try asking me about your errors, performance, or releases instead."
4. Do NOT generate code, write essays, or perform tasks unrelated to querying Sentry data.
5. When presenting Sentry data, be clear and concise. Explain what the data means in an observability context and suggest actionable fixes when relevant.
6. Format responses using markdown. Use code blocks with language tags only when showing stack traces or code snippets from Sentry issues.
7. If a question is ambiguous, ask the user to clarify which Sentry project, time range, or issue they mean — then make the appropriate tool call.`,
      messages: await convertToModelMessages(messages),
      tools,
      stopWhen: stepCountIs(25),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "sentry-mcp-chat",
        recordInputs: true,
        recordOutputs: true,
      },
      onFinish: async () => {
        await mcpClient?.close();
      },
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      onError: (error) => {
        if (error instanceof Error) {
          return error.message;
        }
        return "An error occurred while processing your request.";
      },
    });
  } catch (error) {
    await mcpClient?.close();
    console.error("Chat API error:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "Internal server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
