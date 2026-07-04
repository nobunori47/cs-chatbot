"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";

const SESSION_KEY = "cs_chat_session_id";
const CONVERSATION_KEY = "cs_chat_conversation_id";

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    initSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const supabase = supabaseRef.current;

    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  async function initSession() {
    const supabase = supabaseRef.current;

    let sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, sessionId);
    }

    const storedConvId = localStorage.getItem(CONVERSATION_KEY);

    if (storedConvId) {
      const { data: msgs, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", storedConvId)
        .order("created_at", { ascending: true });

      if (!error) {
        if (msgs) setMessages(msgs);
        setConversationId(storedConvId);
        return;
      }
      localStorage.removeItem(CONVERSATION_KEY);
    }

    const { data: conv } = await supabase
      .from("conversations")
      .insert({ customer_session_id: sessionId })
      .select()
      .single();

    if (conv) {
      localStorage.setItem(CONVERSATION_KEY, conv.id);
      setConversationId(conv.id);
    }
  }

  async function sendMessage() {
    if (!input.trim() || !conversationId || isLoading) return;

    const content = input.trim();
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content }),
      });
      if (!res.ok) throw new Error("Request failed");
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      setIsLoading(false);
    }
  }

  return { messages, input, setInput, isLoading, sendMessage };
}
