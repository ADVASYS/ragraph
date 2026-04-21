import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Send, Square, Image as ImageIcon, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Attachment {
  name: string;
  path: string;
  mime: string;
  kind: "image" | "file";
  previewUrl?: string;
}

interface Props {
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (content: string, attachments?: Attachment[]) => void;
  onStop: () => void;
}

export function MessageComposer({ disabled, isStreaming, onSend, onStop }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textRef.current) {
      textRef.current.style.height = "auto";
      textRef.current.style.height = Math.min(textRef.current.scrollHeight, 240) + "px";
    }
  }, [text]);

  const handleSubmit = () => {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    onSend(content, attachments);
    setText("");
    setAttachments([]);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      const isImage = f.type.startsWith("image/");
      const path = (f as unknown as { path?: string }).path;
      if (!path) continue;
      next.push({
        name: f.name,
        path,
        mime: f.type,
        kind: isImage ? "image" : "file",
        previewUrl: isImage ? URL.createObjectURL(f) : undefined,
      });
    }
    setAttachments((a) => [...a, ...next]);
  };

  return (
    <div className="border-t border-border/60 bg-white/70 backdrop-blur-sm">
      <div className="max-w-3xl mx-auto px-6 py-4">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, idx) => (
              <div
                key={idx}
                className="relative flex items-center gap-2 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs shadow-sm"
              >
                {a.kind === "image" ? (
                  a.previewUrl ? (
                    <img src={a.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5" />
                  )
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                <span className="truncate max-w-[160px]">{a.name}</span>
                <button
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setAttachments((xs) => xs.filter((_, i) => i !== idx))}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={cn(
            "rounded-2xl border border-border bg-white shadow-sm focus-within:ring-2 focus-within:ring-ring transition-all",
            disabled && "opacity-60",
          )}
        >
          <Textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={disabled || isStreaming}
            placeholder={t("chat.placeholder") as string}
            className="border-0 shadow-none focus-visible:ring-0 resize-none min-h-[56px] max-h-60"
            rows={1}
          />
          <div className="flex items-center justify-between px-3 pb-2 pt-0.5">
            <div className="flex items-center gap-1.5">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => fileRef.current?.click()}
                disabled={disabled}
                title={t("chat.attach")}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
            {isStreaming ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                <Square className="h-4 w-4" /> {t("chat.stop")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={disabled || (!text.trim() && attachments.length === 0)}
              >
                <Send className="h-4 w-4" /> {t("chat.send")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
