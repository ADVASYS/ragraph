import { generateText, streamObject } from "ai";
import { z } from "zod";
import log from "electron-log/main.js";
import type { LLMProviderHandle } from "../providers/LLMProvider";

/** Per-phase progress reporter used during document analysis. */
export interface AnalyzeProgress {
  /** Sub-phase: "summarize" = map step, "structure" = final structured call. */
  phase: "summarize" | "structure";
  /** 1-based step counter within the sub-phase. */
  step: number;
  /** Total steps in the sub-phase (for "structure" this is a progress proxy based on fields produced). */
  total: number;
}

/**
 * Existing graph knowledge surfaced to the analyzer so it can reuse canonical
 * names instead of emitting fresh surface variants. The pipeline populates this
 * by embedding the document preview and querying the vector store for similar
 * entity / topic records.
 *
 * Kept deliberately small (a few dozen items at most) so the prompt overhead
 * stays flat regardless of universe size.
 */
export interface AnalyzerGraphContext {
  knownEntities: Array<{ name: string; type: string; aliases: string[] }>;
  knownTopics: Array<{ name: string }>;
}

export const AnalysisSchema = z.object({
  domain: z.string().min(1).describe("Single top-level domain, e.g. 'technology', 'medicine'."),
  topics: z.array(z.string()).min(1).max(10).describe("Specific topics covered."),
  keywords: z.array(z.string()).min(1).max(20).describe("Salient keywords."),
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["person", "organization", "product", "concept", "location", "event", "other"]),
      description: z.string().optional(),
    }),
  ).max(40),
  summary: z.string().min(50).describe("2-6 paragraph neutral summary."),
  references: z.array(z.string()).max(20).describe("External references or document titles."),
  title: z.string().describe("Concise human title for the document."),
  relations: z
    .array(
      z.object({
        src: z.string().describe("Source entity or topic name, exactly as in the entities/topics list."),
        dst: z.string().describe("Target entity or topic name, exactly as in the entities/topics list."),
        type: z
          .enum(["related", "part_of"])
          .describe("'related' connects two entities, 'part_of' asserts that src is a sub-topic of dst."),
        predicate: z
          .string()
          .min(2)
          .max(48)
          .optional()
          .describe(
            "For 'related' only: short verb-phrase describing HOW src relates to dst, lower_snake_case. Examples: works_at, located_in, founded_by, part_of_org, owns, authored, causes, enables, uses, succeeds, competes_with. Omit only when no specific predicate applies (then defaults to 'related_to').",
          ),
        note: z.string().optional().describe("Optional short rationale (<=100 chars)."),
      }),
    )
    .max(30)
    .optional()
    .describe(
      "Binary knowledge-graph triples extracted from the text. Use 'related' with a typed `predicate` to create (subject, predicate, object) triples between entities. Use 'part_of' for topic hierarchy. Only emit relations that are directly supported by the document.",
    ),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

const SYSTEM = `You are a precise knowledge graph curator. You read a document and extract:
- a single broad domain
- specific topics
- canonical entities (deduplicated, normalized names)
- salient keywords
- a clear, neutral summary preserving key facts, numbers and names
- references if explicitly present
- (optionally) binary relations:
  * Use 'related' with a typed predicate field (lower_snake_case verb phrase) to encode (subject, predicate, object) triples between two entities. Stick to a small, reusable vocabulary such as: works_at, located_in, founded_by, owns, authored, acquired, uses, enables, causes, partner_of, competes_with, replaces, precedes, succeeds, member_of, operates_in. Invent new predicates only when none of the common ones fit and keep them concise.
  * Use 'part_of' to express that one topic is a sub-topic of another topic.

CRITICAL — reuse existing knowledge:
When the caller supplies an "Existing knowledge-graph context" block listing
already-known entities or topics, you MUST reuse those exact canonical names
whenever the document refers to the same real-world concept, person, product
or organization. Only invent a new name if the concept is clearly distinct
from every listed candidate. This keeps the graph coherent across documents.

Respond only using the provided structured format. Do not invent information that is not in the text.
Use the primary language of the document for free-text fields.`;

/** Ordered list of fields we expect during streaming — used to derive a progress fraction. */
const EXPECTED_FIELDS: ReadonlyArray<keyof Analysis> = [
  "title", "domain", "topics", "keywords", "entities", "summary", "references", "relations",
];

/**
 * Analyze a document with the configured LLM and return a structured knowledge payload.
 * For large documents we run a map-reduce summary first, then stream the structured extraction
 * so the UI can tick progress as each field arrives. No hard timeout — we wait for the model.
 *
 * When `graphContext` is provided, the analyzer is biased to reuse existing
 * canonical entity / topic names, which keeps the cross-document graph coherent
 * instead of producing parallel surface variants.
 */
export async function analyzeDocument(
  llm: LLMProviderHandle,
  title: string,
  text: string,
  onProgress?: (p: AnalyzeProgress) => void,
  graphContext?: AnalyzerGraphContext,
): Promise<Analysis> {
  const body = text.length > 24000
    ? await mapReduceSummarize(llm, text, onProgress)
    : text;

  return streamStructure(llm, title, body, onProgress, graphContext);
}

/**
 * Render the known-entities / known-topics lists into a compact prompt block.
 * Empty or undefined input produces an empty string so the prompt stays clean
 * on fresh universes.
 */
function renderGraphContext(ctx?: AnalyzerGraphContext): string {
  if (!ctx) return "";
  const entityLines = ctx.knownEntities.slice(0, 40).map((e) => {
    const aliasSuffix = e.aliases.length ? ` (aliases: ${e.aliases.slice(0, 5).join(", ")})` : "";
    return `- ${e.name} [${e.type}]${aliasSuffix}`;
  });
  const topicLines = ctx.knownTopics.slice(0, 25).map((t) => `- ${t.name}`);
  if (entityLines.length === 0 && topicLines.length === 0) return "";
  const parts: string[] = ["Existing knowledge-graph context for this universe:"];
  if (entityLines.length) parts.push(`\nKnown entities (prefer these exact names when applicable):\n${entityLines.join("\n")}`);
  if (topicLines.length) parts.push(`\nKnown topics (prefer these exact names when applicable):\n${topicLines.join("\n")}`);
  parts.push(
    "\nReuse the names above verbatim when the document refers to the same real-world concept. Only introduce a new name when no candidate matches.",
  );
  return parts.join("\n");
}

async function streamStructure(
  llm: LLMProviderHandle,
  title: string,
  body: string,
  onProgress?: (p: AnalyzeProgress) => void,
  graphContext?: AnalyzerGraphContext,
): Promise<Analysis> {
  const total = EXPECTED_FIELDS.length;
  onProgress?.({ phase: "structure", step: 0, total });

  const started = Date.now();
  const ctxBlock = renderGraphContext(graphContext);
  log.info("analyze.structure start", {
    chars: body.length,
    knownEntities: graphContext?.knownEntities.length ?? 0,
    knownTopics: graphContext?.knownTopics.length ?? 0,
  });

  const prompt = ctxBlock
    ? `${ctxBlock}\n\n---\nDocument title (may be a filename): ${title}\n\n---\n${body}`
    : `Document title (may be a filename): ${title}\n\n---\n${body}`;

  try {
    const result = streamObject({
      model: llm.chatModel,
      schema: AnalysisSchema,
      system: SYSTEM,
      prompt,
      temperature: 0.1,
      maxRetries: 1,
    });

    const seen = new Set<string>();
    for await (const partial of result.partialObjectStream) {
      for (const key of EXPECTED_FIELDS) {
        if (key in partial && !seen.has(key)) {
          seen.add(key);
          log.info("analyze.structure field", { key, elapsed: Date.now() - started });
          onProgress?.({ phase: "structure", step: seen.size, total });
        }
      }
    }

    const object = await result.object;
    onProgress?.({ phase: "structure", step: total, total });
    log.info("analyze.structure finished", { ms: Date.now() - started, chars: body.length });
    return object;
  } catch (err) {
    log.error("analyze.structure failed", { ms: Date.now() - started }, err);
    throw err;
  }
}

async function mapReduceSummarize(
  llm: LLMProviderHandle,
  text: string,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<string> {
  const size = 18000;
  const slices: string[] = [];
  for (let i = 0; i < text.length; i += size) slices.push(text.slice(i, i + size));

  const parts: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    const started = Date.now();
    log.info("analyze.summarize slice start", { step: i + 1, total: slices.length, inChars: slices[i].length });
    const r = await generateText({
      model: llm.chatModel,
      system: "You produce a dense, neutral summary preserving entities, numbers, dates and relationships.",
      prompt: slices[i],
      temperature: 0.1,
      maxRetries: 1,
    });
    parts.push(r.text);
    log.info("analyze.summarize slice done", {
      step: i + 1,
      total: slices.length,
      ms: Date.now() - started,
      inChars: slices[i].length,
      outChars: r.text.length,
    });
    onProgress?.({ phase: "summarize", step: i + 1, total: slices.length });
  }
  return parts.join("\n\n");
}
