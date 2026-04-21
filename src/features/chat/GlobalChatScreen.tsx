import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { ChatView } from "./ChatView";

export function GlobalChatScreen({ route: _route }: { route: { name: "global"; chatId?: string } }) {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-3 px-6 py-4 border-b border-border/60 bg-white/60 backdrop-blur-sm">
        <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-sm">
          <Globe className="h-4 w-4 text-white" />
        </div>
        <div>
          <div className="text-[15px] font-semibold">{t("chat.globalTitle")}</div>
          <div className="text-xs text-muted-foreground">{t("chat.globalHint")}</div>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <ChatView universeId={null} />
      </div>
    </div>
  );
}
