import {
  convertToModelMessages,
  streamText,
  UIMessage,
  stepCountIs,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { cookies } from "next/headers";
import { decryptSession, COOKIE_NAME } from "@/app/lib/mcp-auth";
import * as Sentry from "@sentry/nextjs";

export const maxDuration = 60;

export async function POST(req: Request) {
  let mcpClient: MCPClient | undefined;

  try {
    const { messages }: { messages: UIMessage[] } = await req.json();

    // Read session from encrypted cookie
    const cookieStore = await cookies();
    const encrypted = cookieStore.get(COOKIE_NAME)?.value;
    const session = encrypted ? await decryptSession(encrypted) : null;

    if (!session?.tokens?.access_token) {
      return new Response(
        JSON.stringify({ error: "Not authenticated with Sentry" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Link all AI spans in this request to the user's conversation
    Sentry.setConversationId(session.tokens.access_token.slice(-16));

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
      model: anthropic("claude-sonnet-4-6"),
      system: `You are a Sentry observability assistant. You help users query and understand their Sentry data using the available MCP tools. Your focus is Sentry and application observability.

GUIDELINES:
1. Use the available Sentry tools to fetch real data whenever possible. Prefer making tool calls over answering from memory.
2. Your primary domain is Sentry and application observability: errors, issues, performance, traces, releases, alerts, projects, teams, replays, crons, metrics, AI monitoring, and MCP.
3. If a user asks about something completely unrelated to software or observability, gently redirect them. But if they ask about general software concepts in the context of debugging or understanding their Sentry data, that's fine to help with.
4. When presenting Sentry data, be clear and concise. Explain what the data means and suggest actionable fixes when relevant.
5. Format responses using markdown. Use code blocks with language tags when showing stack traces or code snippets from Sentry issues.
6. If a question is ambiguous, ask the user to clarify which Sentry project, time range, or issue they mean — then make the appropriate tool call.
7. Always attempt to call tools first before saying you cannot help. The tools have broad capabilities.`,
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
