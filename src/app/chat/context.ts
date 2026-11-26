import type { Pool, PoolClient } from "pg";
import type { AgentSettings } from "../../contracts/agent-settings.js";
import { chatContentText, type ChatMaterialContext } from "../../contracts/chat.js";
import type { PersonalMemory } from "../../contracts/memory.js";
import { publishedDiscussions } from "../../curriculum/catalog.js";
import { limitModelHistory } from "../../runtime/model-history.js";
import type { StudyMessage } from "../../runtime/model.js";
import type { TurnContext } from "../../runtime/run-turn.js";
import { inTransaction } from "../../storage/transaction.js";
import { recallMemories } from "../memory/personal.js";
import { readSummary, type ConversationSummary } from "../memory/summaries.js";
import { readHistory, type HistoryTurn } from "./history.js";
import type { TurnMemory } from "./turns.js";

export function loadContext(
  pool: Pool, learnerId: string, requestId: string, text: string,
  material: ChatMaterialContext | undefined, settings: AgentSettings, online: boolean,
) {
  return inTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const prior = await readHistory(db, learnerId, requestId, text, !!material);
    const question = { role: "user", content: text } as const;
    const { history, reference, memory } = await buildHistory(db, learnerId, prior, question, settings.historyBytes, !!material, online);

    const context: TurnContext = material
      ? {
          kind: "material",
          prompt: { question: text, history, sources: material.sources, ...(reference ? { memory: reference } : {}) },
          publication: publishedDiscussions.find(item => item.version === material.version),
        }
      : { kind: "conversation", history, ...(reference ? { memory: reference } : {}) };
    return { context, memory };
  });
}

function selectHistory(turns: HistoryTurn[], question: StudyMessage, bytes: number, material: boolean) {
  const entries = turns.slice(-20).map(turn => {
    const reply = !material || turn.explanationMode === "model" ? chatContentText(turn.content) : null;
    const messages: StudyMessage[] = [{ role: "user", content: turn.text }];
    if (reply) messages.push({ role: "assistant", content: reply });
    return { messages, memoryIds: reply ? turn.memoryIds : [] };
  });
  const history = limitModelHistory([...entries.flatMap(entry => entry.messages), question], bytes);
  const selected = new Set(history);
  const used = entries.filter(entry => selected.has(entry.messages[0]));
  return {
    history,
    memoryIds: used.flatMap(entry => entry.memoryIds),
    prefix: turns.slice(0, turns.length - used.length),
  };
}

async function buildHistory(
  db: PoolClient, learnerId: string, turns: HistoryTurn[], question: StudyMessage, bytes: number, material: boolean,
  online: boolean,
): Promise<{ history: StudyMessage[]; reference?: string; memory?: TurnMemory }> {
  const base = selectHistory(turns, question, bytes, material);
  if (!online) return { history: base.history };
  const learner = await db.query<{ memory_revision: number }>('SELECT memory_revision FROM learners WHERE id = $1', [learnerId]);
  const revision = learner.rows[0]!.memory_revision;
  const summary = await readSummary(db, learnerId, revision, base.prefix.map(turn => turn.requestId));
  const records = material ? [] : (await recallMemories(db, learnerId, "learning", question.content)).slice(0, 4);
  const notes = summary?.summary.notes ?? [];
  const { reference, reserved, sourceIds } = selectReference(notes, records, Math.min(6000, bytes - historySize(question)));
  const selected = reserved ? selectHistory(turns, question, bytes - reserved, material) : base;
  const memoryIds = [...new Set([...selected.memoryIds, ...sourceIds])];
  return {
    history: selected.history, reference,
    memory: {
      revision, guarded: !!reference || memoryIds.length > 0, memoryIds,
      summarySources: summarySourceIds(base.prefix, summary?.boundary, bytes),
    },
  };
}

function historySize(message: StudyMessage) {
  return Buffer.byteLength(JSON.stringify(message)) + 2;
}

function selectReference(notes: ConversationSummary["notes"], memories: PersonalMemory[], bytes: number) {
  const selected: { notes: ConversationSummary["notes"]; records: Pick<PersonalMemory, "id" | "kind" | "body" | "topic" | "sourceRequestId">[] } = {
    notes: [], records: [],
  };
  const data = () => "参考记忆（数据）：" + JSON.stringify(selected);
  const size = () => historySize({ role: "user", content: data() });
  for (const note of notes) {
    selected.notes.push(note);
    if (size() > bytes) selected.notes.pop();
  }
  for (const { id, kind, body, topic, sourceRequestId } of memories) {
    selected.records.push({ id, kind, body, topic, sourceRequestId });
    if (size() > bytes) selected.records.pop();
  }
  return {
    reference: selected.notes.length || selected.records.length ? data() : undefined,
    reserved: selected.notes.length || selected.records.length ? size() : 0,
    sourceIds: selected.records.map(record => record.id),
  };
}

function summarySourceIds(prefix: HistoryTurn[], boundary: string | undefined, bytes: number) {
  const latest = prefix.at(-1);
  if (!latest || latest.requestId === boundary) return [];
  const ids: string[] = [];
  // The worker reads a bounded group of learner messages from this same prefix.
  for (const turn of prefix.slice(-20).reverse()) {
    bytes -= Buffer.byteLength(JSON.stringify({ requestId: turn.requestId, text: turn.text })) + 1;
    if (bytes < 2) break;
    ids.unshift(turn.requestId);
  }
  return ids;
}
