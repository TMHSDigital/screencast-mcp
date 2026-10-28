/**
 * Optional model-driven agent for the evals: a plain tool-use loop over the
 * Claude Messages API, with the server's MCP tools offered as client tools.
 *
 * The Anthropic SDK is NOT a dependency of this package. It is loaded with a
 * dynamic import only in this mode; install it ad hoc with
 * `npm install --no-save @anthropic-ai/sdk`. Credentials come from the SDK's
 * usual sources (ANTHROPIC_API_KEY, ...). EVAL_MODEL overrides the model and
 * EVAL_EFFORT (low|medium|high|xhigh|max) sets output_config.effort.
 *
 * No server-side refusal fallback is configured on purpose: a fallback would
 * score a different model than the one named in the results.
 */
import type { EvalAgent, EvalSession } from "./harness.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TURNS = 12;
const MAX_RESULT_CHARS = 20_000;

// The few SDK shapes used here, declared locally because the SDK is optional
// and its types are not installed.
interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
type ContentBlock = TextBlock | ToolUseBlock | { type: string };
interface MessageResponse { content: ContentBlock[]; stop_reason: string | null }
interface MessagesClient {
  messages: { create(body: Record<string, unknown>): Promise<MessageResponse> };
}

async function loadClient(): Promise<MessagesClient> {
  const spec = "@anthropic-ai/sdk";
  let mod: { default: new () => MessagesClient };
  try {
    mod = (await import(spec)) as { default: new () => MessagesClient };
  } catch {
    throw new Error(
      "The anthropic eval mode needs the Anthropic SDK, which is not a dependency of this package. " +
        "Install it for this checkout with: npm install --no-save @anthropic-ai/sdk",
    );
  }
  return new mod.default();
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
function isText(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}

async function toolDefs(session: EvalSession) {
  const tools = await session.listTools();
  return tools.map((t) => {
    const schema: Record<string, unknown> = { ...t.inputSchema };
    delete schema.$schema;
    return { name: t.name, description: t.description ?? "", input_schema: schema };
  });
}

export function anthropicAgent(model = process.env.EVAL_MODEL || DEFAULT_MODEL): EvalAgent {
  let client: MessagesClient | undefined;
  return {
    name: `anthropic:${model}`,
    async run(_task, prompt, session) {
      client ??= await loadClient();
      const tools = await toolDefs(session);
      const system = [
        session.instructions ?? "",
        "You are acting for a user on their local files. Complete the request with the available tools " +
          "without asking clarifying questions, then reply with a short summary of the result.",
      ].join("\n\n");
      const effort = process.env.EVAL_EFFORT;
      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: prompt }];
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await client.messages.create({
          model,
          max_tokens: 16_000,
          system,
          tools,
          messages,
          ...(effort ? { output_config: { effort } } : {}),
        });
        // Append the whole content (thinking blocks included) so the history stays valid.
        messages.push({ role: "assistant", content: res.content });
        if (res.stop_reason === "refusal") throw new Error("model refused the task");
        const uses = res.content.filter(isToolUse);
        if (uses.length === 0) {
          return res.content.filter(isText).map((b) => b.text).join("\n");
        }
        const results = [];
        for (const use of uses) {
          const input = use.input && typeof use.input === "object" ? (use.input as Record<string, unknown>) : {};
          const rec = await session.call(use.name, input);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: rec.text.slice(0, MAX_RESULT_CHARS) || "(no text output)",
            is_error: rec.isError,
          });
        }
        // All results for one assistant turn go back in a single user message.
        messages.push({ role: "user", content: results });
      }
      throw new Error(`no final answer within ${MAX_TURNS} turns`);
    },
  };
}
