import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it } from "@jest/globals";
import { emailExtractionSchema } from "../../../src/modules/emails/extraction.js";

describe("LangChain OpenAI structured output", () => {
  it("builds a structured-output runnable from the existing Zod extraction schema", () => {
    const model = new ChatOpenAI({
      model: "gpt-6-luna",
      apiKey: "test-key",
      maxRetries: 0,
      useResponsesApi: true,
    });

    const structuredModel = model.withStructuredOutput(emailExtractionSchema, {
      name: "email_extraction",
      method: "jsonSchema",
      strict: true,
    });

    expect(structuredModel).toBeDefined();
  });
});
