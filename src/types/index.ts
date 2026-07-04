export type Message = {
  id: string;
  conversation_id: string;
  sender_type: "user" | "assistant" | "operator";
  content: string;
  created_at: string;
};

export type Conversation = {
  id: string;
  customer_session_id: string;
  status: string | null;
  created_at: string;
};

export type User = {
  id: string;
  email: string;
  created_at: string;
};
