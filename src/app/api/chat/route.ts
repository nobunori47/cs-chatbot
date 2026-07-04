import { NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic/client";
import { createClient } from "@supabase/supabase-js";

function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error("[api/chat] Supabase env vars missing:", {
      NEXT_PUBLIC_SUPABASE_URL: url ? "SET" : "MISSING",
      SUPABASE_SERVICE_ROLE_KEY: key ? "SET" : "MISSING",
    });
    throw new Error("Supabase configuration is incomplete");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export async function POST(request: Request) {
  const { conversationId, content } = await request.json();

  if (!conversationId || !content) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  console.log("[api/chat] SUPABASE_SERVICE_ROLE_KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET ✓" : "MISSING ✗");

  let supabase: ReturnType<typeof createSupabaseAdmin>;
  try {
    supabase = createSupabaseAdmin();
    console.log("[api/chat] Supabase admin client initialized ✓");
  } catch (e) {
    console.error("[api/chat] createSupabaseAdmin threw:", e);
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  // ユーザーメッセージを保存
  const { error: insertError } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_type: "user", content });

  if (insertError) {
    console.error("[api/chat] Failed to insert user message:", {
      code: insertError.code,
      message: insertError.message,
      details: insertError.details,
      hint: insertError.hint,
      conversationId,
    });
    return NextResponse.json(
      { error: "Failed to save message", detail: insertError.message },
      { status: 500 }
    );
  }

  // 会話履歴を取得
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("sender_type, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (historyError) {
    console.error("[api/chat] Failed to fetch history:", {
      code: historyError.code,
      message: historyError.message,
      details: historyError.details,
      hint: historyError.hint,
      conversationId,
    });
  }

  // Claude API 呼び出し
  const aiResponse = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system:
      "You are a helpful customer support assistant. Be concise, friendly, and accurate. If you don't know something, say so honestly.",
    messages: (history ?? []).map((m) => ({
      role: m.sender_type as "user" | "assistant",
      content: m.content,
    })),
  });

  const assistantContent =
    aiResponse.stop_reason === "refusal" || aiResponse.content[0]?.type !== "text"
      ? "申し訳ありませんが、そのリクエストにはお答えできません。"
      : aiResponse.content[0].text;

  // アシスタントメッセージを保存
  const { error: assistantInsertError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    sender_type: "assistant",
    content: assistantContent,
  });

  if (assistantInsertError) {
    console.error("[api/chat] Failed to insert assistant message:", {
      code: assistantInsertError.code,
      message: assistantInsertError.message,
      details: assistantInsertError.details,
      hint: assistantInsertError.hint,
      conversationId,
    });
  }

  return NextResponse.json({ ok: true });
}
