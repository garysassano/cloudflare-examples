import {
  type CreateChatCompletionOptions,
  LLMClient,
  type LLMResponse,
  type LogLine,
} from "@browserbasehq/stagehand";
import zodToJsonSchema from "zod-to-json-schema";

// Any Workers AI text-generation model with an OpenAI-compatible chat API and
// JSON Schema output works here. Qwen 3.8 27B is available on the Workers Free
// plan and has a 262k token context, which matters because Stagehand sends the
// page's whole accessibility tree with every call.
export const DEFAULT_MODEL = "@cf/qwen/qwen3.8-27b" satisfies keyof AiModels;

// Qwen 3.8 defaults to xhigh reasoning. Each Stagehand call is one narrow
// question, so low reasoning answers it faster and for fewer output tokens.
const REASONING_EFFORT = "low";

type ChatModel = typeof DEFAULT_MODEL;

type WorkersAIOptions = AiOptions & {
  logger?: (line: LogLine) => void;
};

type ChatOutput = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

// Stagehand retries a malformed structured response itself in its built-in
// clients; this mirrors that for Workers AI.
const MAX_RETRIES = 2;

// Stagehand 2.5 LLMClient backed by the Workers AI binding. Every call Stagehand
// makes (observe, act, extract) carries a Zod `response_model`, and expects the
// parsed, schema-valid object back as `data`.
export class WorkersAIClient extends LLMClient {
  public type = "workers-ai" as const;
  private binding: Ai;
  private model: ChatModel;
  private options?: WorkersAIOptions;

  constructor(binding: Ai, options?: WorkersAIOptions & { model?: ChatModel }) {
    const model = options?.model ?? DEFAULT_MODEL;
    super(model);
    this.binding = binding;
    this.model = model;
    this.options = options;
  }

  async createChatCompletion<T = LLMResponse>({
    options,
    retries = 0,
  }: CreateChatCompletionOptions): Promise<T> {
    const responseModel = options.response_model;
    this.options?.logger?.({ category: "workersai", message: "thinking..." });

    // Stagehand's message shapes are structurally looser than the generated
    // Workers AI input types, but the model accepts them at runtime.
    const inputs = {
      messages: options.messages,
      temperature: options.temperature ?? 0,
      reasoning_effort: REASONING_EFFORT,
      response_format: responseModel
        ? {
            type: "json_schema",
            json_schema: {
              name: responseModel.name,
              schema: zodToJsonSchema(responseModel.schema),
            },
          }
        : undefined,
    } as unknown as AiModels[ChatModel]["inputs"];

    const output = (await this.binding.run(this.model, inputs, this.options)) as ChatOutput;
    const content = output.choices?.[0]?.message?.content ?? "";
    const usage = {
      prompt_tokens: output.usage?.prompt_tokens ?? 0,
      completion_tokens: output.usage?.completion_tokens ?? 0,
      total_tokens: output.usage?.total_tokens ?? 0,
    };
    this.options?.logger?.({ category: "workersai", message: "completed thinking!" });

    if (!responseModel) return { data: content, usage } as T;

    const parsed = responseModel.schema.safeParse(parseJson(content));
    if (parsed.success) return { data: parsed.data, usage } as T;

    if (retries < MAX_RETRIES) {
      return this.createChatCompletion<T>({
        options,
        retries: retries + 1,
      } as CreateChatCompletionOptions);
    }
    throw new Error(
      `${this.model} returned no valid ${responseModel.name} after ${MAX_RETRIES + 1} attempts: ${parsed.error.message}`,
    );
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
