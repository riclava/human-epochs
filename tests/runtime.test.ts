import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedDiscussions } from "../src/courses/catalog.js";
import { createChatCompletionsModel } from "../src/models/chat-completions.js";
import type { ObserveRun } from "../src/runtime/diagnostics.js";
import type { MaterialPrompt, ModelMessage, ConversationMessage } from "../src/runtime/model.js";
import { createTurnRunner, type TurnContext } from "../src/runtime/run-turn.js";
import { conversationContentText } from "../src/contracts/conversation.js";
import { conversationCitations, modelChunk } from "./fixtures/conversation-stream.js";

const deadline = () => new Date(Date.now() + 90_000);
const done = "data: [DONE]\n\n";
const eventResponse = (body: BodyInit) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });

test("local guidance uses the user's goal and follows a change of subject", async () => {
  const model = createChatCompletionsModel({
    env: {},
    fetchImpl: async () => { throw new Error("Local guidance must work offline"); },
  });
  assert.equal(model, null);
  const runner = createTurnRunner(model);
  const history: ConversationMessage[] = [];
  async function ask(content: string) {
    history.push({ role: "user", content });
    const result = await runner.runTurn({ kind: "conversation", history }, deadline());
    assert.equal(result.kind, "complete");
    const reply = conversationContentText(result.output.replyBlocks)!;
    history.push({ role: "assistant", content: reply });
    return reply;
  }
  assert.equal(runner.mode, "guided");
  await ask("你好");
  assert.match(await ask("我想学历史。"), /“历史”.*独立做哪件事/u);
  const plan = await ask("我希望能比较两份回忆录");
  assert.match(plan, /比较两份回忆录/u);
  assert.match(plan, /原文/u);
  assert.match(await ask("做完了"), /换一个没见过的例子/u);
  const newTopic = await ask("换个话题，我想学摄影");
  assert.match(newTopic, /摄影/u);
  assert.doesNotMatch(newTopic, /历史|回忆录/u);
  assert.match(await ask("想自己拍一张夜景"), /小样/u);
});

test("configured chat completions include only the prompt and ordered conversation", async () => {
  const env = {
    MODEL_API_KEY: "test-credential",
    MODEL_BASE_URL: "https://model.example.test/v1/",
    MODEL_ID: "test-model",
  };
  const history: ConversationMessage[] = [
    { role: "user", content: "我想学天文" },
    { role: "assistant", content: "你想独立做哪件事？" },
    { role: "user", content: "想认出冬季的星座" },
  ];
  const model = createChatCompletionsModel({
    env,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://model.example.test/v1/chat/completions");
      assert.equal(options?.method, "POST");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-credential");
      const body = JSON.parse(String(options.body));
      assert.equal(body.model, env.MODEL_ID);
      assert.equal(body.stream, true);
      assert.equal(body.messages[0].role, "system");
      assert.deepEqual(body.messages.slice(1), history);
      const usage = 'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":12}}\n\n';
      const bytes = Buffer.from(": heartbeat\r\n\r\n" + modelChunk("  先从一张冬季星图") + modelChunk("开始。 ", "stop") + usage + done);
      const split = bytes.indexOf(Buffer.from("冬")) + 1;
      return eventResponse(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      } }));
    },
  });
  const runner = createTurnRunner(model);
  assert.equal(runner.mode, "model");
  const deltas: string[] = [];
  const events: Parameters<ObserveRun>[0][] = [];
  const result = await runner.runTurn({ kind: "conversation", history }, deadline(), undefined, {
    onTextDelta: text => deltas.push(text), observe: event => events.push(event),
  });
  assert.deepEqual(deltas, ["  先从一张冬季星图", "开始。 "]);
  assert.deepEqual(result, { kind: "complete", output: { replyBlocks: [{ kind: "text", text: "先从一张冬季星图开始。" }] } });
  assert.deepEqual(events.map(event => event.event === "model" && event.usage), [{ inputTokens: 42, outputTokens: 12 }]);
});

test("model failures and incomplete completions remain retryable failures", async () => {
  const env = { MODEL_API_KEY: "test-credential" };
  const history: ConversationMessage[] = [{ role: "user", content: "我想学习西班牙语" }];
  for (const [response, outcome] of [
    [new Response(null, { status: 429 }), "rate_limited"],
    [new Response(null, { status: 503 }), "http_error"],
    [Response.json({ choices: [] }), "invalid_response"],
    [eventResponse(modelChunk(" ", "stop") + done), "invalid_response"],
    [eventResponse(modelChunk("第一步需要", "length") + done), "truncated"],
    [eventResponse(modelChunk("第一步需要", "aborted") + done), "invalid_response"],
    [eventResponse(modelChunk("工具调用中", "tool_calls") + done), "invalid_response"],
    [eventResponse(modelChunk("缺少停止标记") + done), "invalid_response"],
    [eventResponse(modelChunk("缺少结束帧", "stop")), "invalid_response"],
  ] as const) {
    const runner = createTurnRunner(createChatCompletionsModel({ env, fetchImpl: async () => response }));
    const events: Parameters<ObserveRun>[0][] = [];
    assert.deepEqual(await runner.runTurn({ kind: "conversation", history }, deadline(), undefined, { observe: event => events.push(event) }), {
      kind: "failed", reason: "generation",
    });
    assert.deepEqual(events.map(event => event.event === "model" && event.outcome), [outcome]);
  }
});

test("model input trims older history as whole turns and keeps the current question", async () => {
  const prior = Array.from({ length: 4 }, (_, index): ConversationMessage[] => [
    { role: "user", content: String(index).repeat(4_000) },
    { role: "assistant", content: "a".repeat(4_000) },
  ]).flat();
  const question = "怎么把前面几条线索串起来？";
  const history: ConversationMessage[] = [...prior, { role: "user", content: question }];
  const source = { id: "log", label: "记录", text: "数据在周一录入。" };
  const modelHistories: unknown[] = [];
  const runner = createTurnRunner(async ({ messages, format }) => {
    if (format === "text") {
      modelHistories.push(messages);
      return { kind: "text", text: "按时间排列。" };
    }
    modelHistories.push(JSON.parse(messages[0].content!).history);
    return {
      kind: "text",
      text: JSON.stringify({ blocks: [{ kind: "text", text: "可以从录入日期开始。", citations: [{ sourceId: source.id, quote: source.text }] }] }),
    };
  });

  const conversation = await runner.runTurn({ kind: "conversation", history }, deadline());
  const material = await runner.runTurn({ kind: "material", prompt: { question, history, sources: [source] } }, deadline());
  assert.deepEqual(modelHistories, [history.slice(2), history.slice(2)]);
  assert.equal(history.length, 9);
  assert.equal(conversation.kind, "complete");
  assert.equal(material.kind, "complete");
  assert.equal(material.output.explanationSource, "model");
});

test("source explanations use the current question and selected evidence, and offline readings yield to unfamiliar evidence", async () => {
  const [publication] = publishedDiscussions;
  const source = publication.sources[0];
  const question = "姨母说渡口什么时候停航？";
  const history: ConversationMessage[] = [{ role: "user", content: publication.question }, { role: "user", content: question }];
  const prompt = { question, sources: [source], history };
  const online = createTurnRunner(async ({ format, messages }) => {
    assert.equal(format, "json");
    const first = messages[0];
    assert.equal(first?.role, "user");
    assert.deepEqual(JSON.parse(first.content), prompt);
    return {
      kind: "text",
      text: JSON.stringify({ blocks: [
        { kind: "excerpt", source: { sourceId: source.id, quote: source.text } },
        { kind: "text", text: "姨母说渡口一入冬便停航。", citations: [{ sourceId: source.id, quote: source.text }] },
      ] }),
    };
  });
  const explanation = await online.runTurn({ kind: "material", publication, prompt }, deadline());
  assert.equal(explanation.kind, "complete");
  assert.equal(explanation.output.explanationSource, "model");
  assert.deepEqual(explanation.output.replyBlocks.map(block => block.kind), ["excerpt", "text"]);
  assert.equal(conversationCitations(explanation.output.replyBlocks)[0]?.label, source.label);

  const correction = { id: "excerpt:correction", label: "更正记录", text: "更正记录：日记的日期写错了，尚不能确定船在什么时候运行。" };
  const followUp = "有了更正记录，现在可以确定什么？";
  const fallback = await createTurnRunner(null).runTurn({
    kind: "material", publication, prompt: {
      question: followUp, sources: [source, ...publication.supplements, correction],
      history: [...history, { role: "user", content: followUp }],
    },
  }, deadline());
  assert.equal(fallback.kind, "complete");
  assert.equal(fallback.output.explanationSource, "excerpt");
  assert.ok(conversationCitations(fallback.output.replyBlocks).some(citation => citation.sourceId === correction.id));
  assert.ok(publication.readings?.every(reading => !conversationContentText(fallback.output.replyBlocks)!.includes(reading.text)));
});

test("the model loop pairs tool errors with their calls and accepts citations only from material read by the model", async () => {
  const first = { id: "a", label: "试验背景", text: "背景".repeat(2100) + "。" };
  const unread = { id: "b", label: "校准日志", text: "设备在 09:05 完成校准。" };
  const question = "设备什么时候完成校准？";
  const prompt: MaterialPrompt = { question, history: [{ role: "user", content: question }], sources: [first, unread] };
  let calls = 0;
  let toolMessages: ModelMessage[] = [];
  const runner = createTurnRunner(async ({ messages }) => {
    calls++;
    if (calls === 1) {
      return {
        kind: "tool_calls", text: null, calls: [
          { id: "unknown", name: "other_tool", arguments: "{}" },
          { id: "invalid", name: "read_source", arguments: JSON.stringify({ sourceId: first.id, extra: true }) },
          { id: "outside", name: "read_source", arguments: JSON.stringify({ sourceId: "other-discussion" }) },
          { id: "background", name: "read_source", arguments: JSON.stringify({ sourceId: first.id }) },
        ],
      };
    }
    toolMessages = messages;
    return {
      kind: "text",
      text: JSON.stringify({ blocks: [{ kind: "text", text: "模型给出的归档结论。", citations: [{ sourceId: unread.id, quote: unread.text }] }] }),
    };
  });

  const events: Parameters<ObserveRun>[0][] = [];
  const progress: string[] = [];
  const result = await runner.runTurn({ kind: "material", prompt }, deadline(), undefined, {
    observe: event => events.push(event), onProgress: stage => progress.push(stage),
  });
  assert.equal(calls, 2);
  const [unknown, invalid, outside, background] = toolMessages.slice(2);
  for (const [message, id] of [[unknown, "unknown"], [invalid, "invalid"], [outside, "outside"]] as const) {
    assert.equal(message?.role, "tool");
    assert.equal(message.toolCallId, id);
    assert.deepEqual(Object.keys(JSON.parse(message.content)), ["error"]);
  }
  assert.deepEqual(background, { role: "tool", toolCallId: "background", content: JSON.stringify(first) });
  assert.equal(result.kind, "complete");
  assert.equal(result.output.explanationSource, "excerpt");
  assert.notEqual(conversationContentText(result.output.replyBlocks), "模型给出的归档结论。");
  assert.deepEqual(progress, ["reading_sources", "checking_citations"]);
  assert.deepEqual(events.filter(event => event.event === "tool").map(event => [event.toolCallId, event.outcome]), [
    ["unknown", "unknown_tool"], ["invalid", "invalid_input"], ["outside", "denied"], ["background", "returned"],
  ]);
  assert.deepEqual(events.at(-1), { event: "material_fallback", reason: "invalid_citation" });
});

test("long material execution reserves a final reply and stops at the model or tool limit", async () => {
  const source = { id: "a", label: "试验记录", text: "背景".repeat(2100) + "。" };
  const question = "试验记录写了什么？";
  const prompt: MaterialPrompt = { question, history: [{ role: "user", content: question }], sources: [source] };
  for (const [readsPerCall, expectedCalls] of [[1, 3], [4, 2]]) {
    const choices: (string | undefined)[] = [];
    const runner = createTurnRunner(async ({ toolChoice }) => {
      choices.push(toolChoice);
      return {
        kind: "tool_calls", text: null, calls: Array.from({ length: readsPerCall }, (_, index) => ({
          id: choices.length + "-" + index, name: "read_source", arguments: JSON.stringify({ sourceId: source.id }),
        })),
      };
    });

    const result = await runner.runTurn({ kind: "material", prompt }, deadline());
    assert.deepEqual(choices, [...Array(expectedCalls - 1).fill(undefined), "none"]);
    assert.equal(result.kind, "complete");
    assert.equal(result.output.explanationSource, "excerpt");
  }
});

test("the runner skips expired attempts and rejects output that arrives after the lease", async () => {
  const expiresAt = new Date("2026-01-01T00:01:00Z");
  let now = expiresAt.getTime();
  let calls = 0;
  const runner = createTurnRunner(async () => {
    calls++;
    now = expiresAt.getTime();
    return { kind: "text", text: "迟到的回复" };
  }, () => now);
  const input: TurnContext = { kind: "conversation", history: [{ role: "user", content: "讲一讲月相" }] };
  const expired = { kind: "failed", reason: "deadline" };

  assert.deepEqual(await runner.runTurn(input, expiresAt), expired);
  assert.equal(calls, 0);
  now -= 1_000;
  assert.deepEqual(await runner.runTurn(input, expiresAt), expired);
  assert.equal(calls, 1);
});
