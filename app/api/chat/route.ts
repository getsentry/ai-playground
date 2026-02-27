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
      system: `You are a helpful Sentry assistant. You have access to Sentry tools via MCP to help users understand their errors, issues, performance data, and more.

When answering questions:
- Use the available Sentry tools to fetch real data
- Present information clearly and concisely
- If you find issues or errors, explain what they mean and suggest fixes
- Format your responses using markdown for readability
- When showing code, use appropriate code blocks with language tags`,
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
