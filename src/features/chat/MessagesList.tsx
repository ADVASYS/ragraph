import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  User as UserIcon,
  Sparkles,
  Loader2,
  ChevronDown,
  Image as ImageIcon,
  FileText,
  Wrench,
  CheckCircle2,
} from "lucide-react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { ChatMessage, SourceRef, ToolInvocation } from "@shared/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/app/store";
import { SourceChip } from "./SourceChip";
import "highlight.js/styles/github.css";

export function MessagesList({
  messages,
  isStreaming,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center p-8">
        <div className="max-w-md">
          <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm text-muted-foreground">{t("chat.empty")}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} isStreaming={isStreaming && m.id === "__streaming__"} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={cn("flex gap-3", isUser ? "flex-row-reverse" : "")}
    >
      <div
        className={cn(
          "h-8 w-8 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm",
          isUser ? "bg-primary text-white" : "bg-white border border-border",
        )}
      >
        {isUser ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4 text-primary" />}
      </div>
      <div className={cn("flex-1 min-w-0", isUser ? "max-w-[80%] ml-auto" : "")}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((a) => (
              <AttachmentPreview key={a.id} attachment={a} />
            ))}
          </div>
        )}

        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <ToolTimeline toolCalls={message.toolCalls} />
        )}

        <div
          className={cn(
            "rounded-2xl px-4 py-3",
            isUser ? "bg-primary text-primary-foreground" : "bg-white border border-border/70",
          )}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{message.content}</div>
          ) : (
            <MarkdownContent text={message.content} sources={message.sources ?? []} />
          )}
          {isStreaming && (
            <div className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>thinking…</span>
            </div>
          )}
        </div>

        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {message.sources.slice(0, 10).map((s) => (
              <SourceChip key={s.id} source={s} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function AttachmentPreview({ attachment }: { attachment: { kind: string; mime: string; name: string } }) {
  const isImage = attachment.kind === "image";
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs shadow-sm">
      {isImage ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
      <span className="truncate max-w-[220px]">{attachment.name}</span>
    </div>
  );
}

function ToolTimeline({ toolCalls }: { toolCalls: ToolInvocation[] }) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="mb-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-xs">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((x) => !x)}
      >
        <Wrench className="h-3.5 w-3.5" />
        <span className="font-medium">{toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 ml-auto transition-transform", expanded && "rotate-180")} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="pt-2 space-y-1.5">
              {toolCalls.map((t) => (
                <div key={t.id} className="flex items-start gap-2">
                  {t.completedAt ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                  ) : (
                    <Loader2 className="h-3.5 w-3.5 text-primary animate-spin mt-0.5 flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-foreground/90">{t.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground truncate">
                      {JSON.stringify(t.input)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Render an assistant message as markdown with inline citation chips.
 *
 * The agent emits citations as `[^<sourceId>]` (legacy `[^source:<id>]` is
 * also accepted). We pre-process the markdown in two passes so the main body
 * keeps its formatting and each citation becomes a link the renderer can
 * replace with a proper chip:
 *
 *   1. Strip the trailing "Sources"-style footer the LLM tends to append —
 *      the chips panel already lists every cited source, so duplicating them
 *      as raw `[^id]` lines just bloats the answer.
 *   2. Replace every `[^id]` with `[n](src:<id>)` where `n` is the 1-based
 *      position in the resolved sources array. That lets us override the
 *      markdown `<a>` component below and render a superscript button that
 *      opens the source viewer on click.
 *
 * Citations whose id doesn't map to any known source are kept as a muted
 * superscript without a click target, so the LLM isn't silently censored.
 */
function MarkdownContent({ text, sources }: { text: string; sources: SourceRef[] }) {
  const prepared = React.useMemo(() => {
    const byId = new Map(sources.map((s, i) => [s.id, i + 1]));
    const legacyRe = /\[\^source:([^\]]+)\]/g;
    const anyRe = /\[\^([a-zA-Z0-9._:-]+)\]/g;

    // Drop everything after a trailing "Sources" / "Quellen" heading — the
    // panel on the right already displays each chip. Regex is intentionally
    // conservative: requires a blank line before the heading so we don't
    // accidentally chop in-body mentions of the word "Sources".
    let body = text.replace(
      /\n{2,}\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Sources|Quellen|References|Referenzen)\s*:?\s*(?:\*\*)?\s*\n[\s\S]*$/i,
      "",
    );

    const replaceCitation = (_m: string, rawId: string): string => {
      const id = rawId.trim();
      const idx = byId.get(id);
      const canonical = id.startsWith("source:") ? id.slice("source:".length) : id;
      const resolvedIdx = idx ?? byId.get(canonical);
      if (resolvedIdx) return ` [${resolvedIdx}](src:${id})`;
      return ` [?](src-missing:${id})`;
    };
    body = body.replace(legacyRe, replaceCitation);
    body = body.replace(anyRe, replaceCitation);
    return body;
  }, [text, sources]);

  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{
          a: (props) => <CitationOrLink {...props} sources={sources} />,
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

interface CitationAnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  sources: SourceRef[];
}

/**
 * Drop-in replacement for markdown `<a>` that turns `src:<id>` / `src-missing:<id>`
 * pseudo-URLs into a citation chip that opens the source viewer. All other
 * hrefs pass through unchanged and open via the OS shell to avoid navigating
 * the Electron window away from the app.
 */
function CitationOrLink({ href, children, sources, ...rest }: CitationAnchorProps) {
  const setActiveSource = useApp((s) => s.setActiveSource);
  const activeSource = useApp((s) => s.activeSource);

  if (typeof href === "string" && (href.startsWith("src:") || href.startsWith("src-missing:"))) {
    const id = href.startsWith("src:") ? href.slice("src:".length) : href.slice("src-missing:".length);
    const source = sources.find((s) => s.id === id);
    const isActive = activeSource?.id === source?.id;

    const content = (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          if (source) setActiveSource(source);
        }}
        disabled={!source}
        className={cn(
          "inline-flex items-center justify-center align-super mx-0.5 h-4 min-w-[18px] px-1 rounded-md border text-[10px] font-semibold leading-none transition-colors no-underline",
          source
            ? isActive
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-muted/60 text-foreground/80 hover:border-primary/40 hover:bg-primary/10 hover:text-primary cursor-pointer"
            : "border-destructive/30 bg-destructive/5 text-destructive/70 cursor-not-allowed",
        )}
      >
        {children}
      </button>
    );

    if (!source) {
      return content;
    }

    return (
      <Tooltip.Provider delayDuration={150}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={4}
              className="max-w-sm z-50 rounded-xl bg-zinc-900 text-white px-3 py-2 text-xs shadow-lg"
            >
              <div className="font-semibold mb-1 line-clamp-2">{source.title}</div>
              {source.snippet && <div className="text-zinc-300 line-clamp-4">{source.snippet}</div>}
              <div className="mt-1.5 text-[10px] text-zinc-400">Click to open the exact excerpt</div>
              <Tooltip.Arrow className="fill-zinc-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }

  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  );
}
