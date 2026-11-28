import type { Pool } from "pg";
import { searchTermLimit, type SearchMatch, type SearchResponse, type SearchResult } from "../contracts/search.js";

const conversationLimit = 20;
const matchesPerConversation = 3;
const snippetBefore = 30;
const snippetLength = 120;

export function searchTerms(query: string) {
  return [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))].slice(0, searchTermLimit);
}

const likePattern = (term: string) => "%" + term.replace(/[\\%_]/gu, "\\$&") + "%";

// Cuts the text around the first matched word and marks every word inside the cut.
export function snippetOf(text: string, terms: readonly string[]): Omit<SearchMatch, "requestId" | "field"> {
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0));
  const start = Number.isFinite(first) ? Math.max(0, first - snippetBefore) : 0;
  const end = Math.min(text.length, start + snippetLength);
  const snippet = text.slice(start, end);
  const ranges: [number, number][] = [];
  const window = lower.slice(start, end);
  for (const term of terms) {
    for (let at = window.indexOf(term); at >= 0; at = window.indexOf(term, at + term.length)) ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const highlights: [number, number][] = [];
  for (const range of ranges) {
    const last = highlights.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else highlights.push([...range]);
  }
  return { snippet, clippedStart: start > 0, clippedEnd: end < text.length, highlights };
}

const found = (text: string, terms: readonly string[]) => terms.filter(term => text.toLowerCase().includes(term)).length;

// The words may be split between a message and its reply; the snippet comes from the side that holds more of them.
function matchedField(message: string, reply: string, terms: readonly string[]): "message" | "reply" {
  return found(message, terms) >= found(reply, terms) ? "message" : "reply";
}

// Searches the user's own conversations: titles, their messages and the text of published replies. Words are matched
// literally, so Chinese works without word splitting; a user's history is small enough to scan.
export async function searchConversations(pool: Pool, userId: string, query: string): Promise<SearchResponse> {
  const terms = searchTerms(query);
  const patterns = terms.map(likePattern);
  const { rows: titles } = await pool.query<{ id: string; title: string; updatedAt: Date }>(`
    SELECT id, title, updated_at AS "updatedAt" FROM conversations
    WHERE user_id = $1 AND title ILIKE ALL ($2::text[]) ORDER BY updated_at DESC, id LIMIT ${conversationLimit + 1}
  `, [userId, patterns]);
  const { rows: turns } = await pool.query<{ id: string; title: string; updatedAt: Date; requestId: string; message: string | null; reply: string | null }>(`
    SELECT c.id, c.title, c.updated_at AS "updatedAt", t.request_id AS "requestId", t.message, t.reply
    FROM conversations c
    JOIN LATERAL (
      SELECT request_id, position, message_text AS message, (
        SELECT string_agg(value #>> '{}', E'\\n') FROM jsonb_path_query(coalesce(reply_blocks, question_blocks), '$[*] ? (@.kind == "text").text') value
      ) AS reply
      FROM conversation_turns WHERE user_id = c.user_id AND conversation_id = c.id AND status = 'complete'
    ) t ON coalesce(t.message, '') || E'\\n' || coalesce(t.reply, '') ILIKE ALL ($2::text[])
    WHERE c.user_id = $1
    ORDER BY c.updated_at DESC, c.id, t.position DESC LIMIT 400
  `, [userId, patterns]);

  const results = new Map<string, SearchResult>();
  const resultFor = (row: { id: string; title: string; updatedAt: Date }) => {
    let result = results.get(row.id);
    if (!result) results.set(row.id, result = { conversationId: row.id, title: row.title, updatedAt: row.updatedAt.toISOString(), matches: [] });
    return result;
  };
  for (const row of titles) resultFor(row).matches.push({ requestId: null, field: "title", ...snippetOf(row.title, terms) });
  for (const row of turns) {
    const result = resultFor(row);
    if (result.matches.filter(match => match.requestId).length >= matchesPerConversation) continue;
    const field = matchedField(row.message ?? "", row.reply ?? "", terms);
    result.matches.push({ requestId: row.requestId, field, ...snippetOf((field === "message" ? row.message : row.reply) ?? "", terms) });
  }
  const ordered = [...results.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.conversationId.localeCompare(b.conversationId));
  return { query, results: ordered.slice(0, conversationLimit), truncated: ordered.length > conversationLimit };
}
