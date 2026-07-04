"use client";

import { useEffect, useRef, useState, KeyboardEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Conversation, Message } from "@/types";

// ── Hook ────────────────────────────────────────────────────────────────────

function useOperator() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState("");
  const [isSending, setIsSending] = useState(false);
  const supabase = useRef(createClient()).current;

  // 会話一覧の初期ロード
  useEffect(() => {
    supabase
      .from("conversations")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) setConversations(data);
      });
  }, [supabase]);

  // 会話一覧のリアルタイム更新
  useEffect(() => {
    const ch = supabase
      .channel("operator:conversations")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setConversations((prev) => [payload.new as Conversation, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setConversations((prev) =>
              prev.map((c) => (c.id === payload.new.id ? (payload.new as Conversation) : c))
            );
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase]);

  // 選択中の会話のメッセージをロード
  useEffect(() => {
    if (!selectedId) return;
    setMessages([]);
    supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", selectedId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (data) setMessages(data);
      });
  }, [selectedId, supabase]);

  // 選択中の会話のメッセージのリアルタイム更新
  useEffect(() => {
    if (!selectedId) return;
    const ch = supabase
      .channel(`operator:messages:${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => {
          const msg = payload.new as Message;
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [selectedId, supabase]);

  async function sendReply() {
    if (!reply.trim() || !selectedId || isSending) return;
    const content = reply.trim();
    setReply("");
    setIsSending(true);
    try {
      await supabase
        .from("messages")
        .insert({ conversation_id: selectedId, sender_type: "operator", content });
    } finally {
      setIsSending(false);
    }
  }

  return { conversations, selectedId, setSelectedId, messages, reply, setReply, isSending, sendReply };
}

// ── UI helpers ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; dot: string; badge: string }> = {
  ai_handling:      { label: "AI対応中",   dot: "bg-blue-400",  badge: "bg-blue-100 text-blue-700"  },
  waiting_operator: { label: "要対応",     dot: "bg-amber-400", badge: "bg-amber-100 text-amber-700" },
  resolved:         { label: "解決済",     dot: "bg-green-400", badge: "bg-green-100 text-green-700" },
};

function StatusBadge({ status }: { status: string | null }) {
  const cfg = STATUS_CONFIG[status ?? ""] ?? {
    label: status ?? "不明",
    dot: "bg-gray-400",
    badge: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

const SENDER_LABEL: Record<string, string> = {
  user:     "顧客",
  assistant: "AI",
  operator: "オペレーター",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday
    ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function OperatorPage() {
  const { conversations, selectedId, setSelectedId, messages, reply, setReply, isSending, sendReply } =
    useOperator();

  const selectedConv = conversations.find((c) => c.id === selectedId) ?? null;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  return (
    <div className="flex h-screen bg-gray-100 font-sans antialiased">

      {/* ── Left: Conversation List ─────────────────────────────────────── */}
      <aside className="w-72 flex-shrink-0 bg-gray-900 flex flex-col border-r border-gray-800">
        {/* Sidebar header */}
        <div className="px-4 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded bg-indigo-500 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
            </div>
            <h1 className="text-white font-bold text-sm">オペレーター管理</h1>
          </div>
          <p className="text-gray-500 text-xs">{conversations.length} 件の会話</p>
        </div>

        {/* Status legend */}
        <div className="px-4 py-2 border-b border-gray-800 flex gap-3 flex-shrink-0">
          {Object.values(STATUS_CONFIG).map((s) => (
            <span key={s.label} className="flex items-center gap-1 text-gray-500 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
              {s.label}
            </span>
          ))}
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="px-4 py-10 text-center text-gray-600 text-sm">
              会話がありません
            </div>
          ) : (
            conversations.map((conv) => {
              const isSelected = conv.id === selectedId;
              const cfg = STATUS_CONFIG[conv.status ?? ""] ?? STATUS_CONFIG["ai_handling"];
              return (
                <button
                  key={conv.id}
                  onClick={() => setSelectedId(conv.id)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800 transition-colors group ${
                    isSelected ? "bg-indigo-600" : "hover:bg-gray-800"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-medium ${
                        isSelected ? "text-indigo-200" : `text-${cfg.badge.split(" ")[1]}`
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                      {cfg.label}
                    </span>
                    <span className={`text-xs ${isSelected ? "text-indigo-300" : "text-gray-500"}`}>
                      {formatTime(conv.created_at)}
                    </span>
                  </div>
                  <p className={`text-sm font-mono truncate ${isSelected ? "text-white" : "text-gray-300"}`}>
                    #{conv.id.slice(0, 8)}
                  </p>
                  <p className={`text-xs truncate mt-0.5 ${isSelected ? "text-indigo-200" : "text-gray-500"}`}>
                    {conv.customer_session_id.slice(0, 16)}…
                  </p>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Right: Conversation Detail ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-gray-200 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <p className="text-gray-500 font-medium">会話を選択してください</p>
              <p className="text-gray-400 text-sm mt-1">左のリストから会話を選ぶと詳細が表示されます</p>
            </div>
          </div>
        ) : (
          <>
            {/* Detail header */}
            <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-semibold text-gray-800">
                  #{selectedConv.id.slice(0, 8)}
                </span>
                <StatusBadge status={selectedConv.status} />
              </div>
              <div className="text-xs text-gray-400 flex items-center gap-4">
                <span>開始: {formatTime(selectedConv.created_at)}</span>
                <span className="text-gray-300">|</span>
                <span className="font-mono">{selectedConv.customer_session_id.slice(0, 16)}…</span>
              </div>
            </header>

            {/* Messages thread */}
            <div className="flex-1 overflow-y-auto px-6 py-5 bg-gray-50 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center text-gray-400 text-sm py-12">
                  メッセージがありません
                </div>
              ) : (
                messages.map((msg) => {
                  const isOperator = msg.sender_type === "operator";
                  const isUser = msg.sender_type === "user";
                  const isAI = msg.sender_type === "assistant";

                  return (
                    <div key={msg.id} className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[65%] ${isOperator ? "items-end" : "items-start"} flex flex-col gap-1`}>
                        {/* Sender label + time */}
                        <div className={`flex items-center gap-2 text-xs ${isOperator ? "flex-row-reverse" : ""}`}>
                          <span className={`font-semibold ${
                            isOperator ? "text-indigo-600" : isAI ? "text-gray-500" : "text-gray-700"
                          }`}>
                            {SENDER_LABEL[msg.sender_type] ?? msg.sender_type}
                          </span>
                          <span className="text-gray-400">{formatTime(msg.created_at)}</span>
                        </div>

                        {/* Bubble */}
                        <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                          isOperator
                            ? "bg-indigo-600 text-white rounded-tr-sm"
                            : isAI
                            ? "bg-gray-200 text-gray-700 rounded-tl-sm"
                            : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm"
                        }`}>
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {/* Reply form */}
            <footer className="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">
              <div className="flex items-end gap-3">
                <div className="flex-1 rounded-xl border border-gray-300 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all overflow-hidden">
                  <div className="px-4 pt-2 pb-1">
                    <span className="text-xs font-semibold text-indigo-600">オペレーターとして返信</span>
                  </div>
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="返信内容を入力… (Enter で送信 / Shift+Enter で改行)"
                    rows={2}
                    disabled={isSending}
                    className="w-full px-4 pb-3 text-sm text-gray-800 placeholder-gray-400 resize-none focus:outline-none disabled:opacity-60 bg-transparent"
                  />
                </div>
                <button
                  onClick={sendReply}
                  disabled={isSending || !reply.trim()}
                  className="h-11 px-6 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                >
                  {isSending ? "送信中…" : "送信"}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-400">
                この返信は <code className="bg-gray-100 px-1 rounded">sender_type: operator</code> でメッセージとして保存されます
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
