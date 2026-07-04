CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_session_id text NOT NULL,
  status text NOT NULL DEFAULT 'ai_handling',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'assistant', 'operator')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public to create conversations" ON conversations
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public to read conversations" ON conversations
  FOR SELECT USING (true);

CREATE POLICY "Allow public to create messages" ON messages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public to read messages" ON messages
  FOR SELECT USING (true);
