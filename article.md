# Claude + Supabase でフルスタック CS チャットボットを作った話

**GitHub**: https://github.com/nobunori47/cs-chatbot  
**デモ**: https://cs-chatbot-flame.vercel.app

---

## 1. はじめに — 何を作ったか

「AI チャットボット」という言葉はもう珍しくないが、**実際の CS 業務に使えるもの**はまだ少ない。よくある実装は「とりあえず OpenAI に投げて表示する」だけで、オペレーターへの引き継ぎや会話の管理まで含んだフルスタックな構成にはなっていないことが多い。

そこで今回作ったのが、以下の構成を持つ顧客サポート（CS）チャットボットだ。

```
顧客
 └─ チャットウィジェット（Web サイトに埋め込み）
       └─ Supabase（メッセージ保存 + リアルタイム配信）
             ├─ Claude AI（自動返答）
             └─ オペレーター管理画面（/operator）
```

顧客はログイン不要で会話を開始できる。Claude が自動で返答しつつ、オペレーターはブラウザの管理画面からすべての会話をリアルタイムで監視し、必要に応じて割り込んで直接返信できる。

**「AI が一次対応、人間が二次対応」という CS の現実に沿ったシステム**を、一から自分で実装してみたのが今回の挑戦だった。

---

## 2. 技術スタック

| 役割 | 技術 | 選定理由 |
|---|---|---|
| フレームワーク | **Next.js 16 (App Router)** | Server / Client Component の分離がバックエンド的思考で書きやすい |
| スタイリング | **Tailwind CSS v4** | ユーティリティファーストで UI の試行錯誤が速い |
| DB + リアルタイム | **Supabase** | PostgreSQL + Realtime + RLS がオールインワン |
| AI エンジン | **Anthropic Claude (`claude-opus-4-8`)** | 日本語の精度と応答の自然さが高い |
| デプロイ | **Vercel** | Next.js との親和性が最高、`git push` で即デプロイ |
| 言語 | **TypeScript** | 型があることで API レスポンスの構造ミスを早期発見できた |

---

## 3. システム構成

### ファイル構成

```
src/
├── app/
│   ├── page.tsx                  # トップページ（ウィジェット設置）
│   ├── operator/page.tsx         # オペレーター管理画面
│   └── api/chat/route.ts         # Claude API を呼ぶサーバーサイド処理
├── components/chat/
│   ├── ChatWidget.tsx            # フローティングチャットボタン
│   ├── MessageList.tsx           # メッセージ一覧
│   ├── MessageBubble.tsx         # 吹き出し UI
│   └── ChatInput.tsx             # 入力欄
├── hooks/useChat.ts              # チャットのビジネスロジック
└── lib/
    ├── supabase/client.ts        # ブラウザ用 Supabase クライアント
    └── anthropic/client.ts       # Claude API クライアント
```

### データベース設計

シンプルに 2 テーブル構成にした。

```sql
-- 会話（顧客ごとのセッション）
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_session_id text NOT NULL,          -- 匿名セッションID
  status              text DEFAULT 'ai_handling', -- ai_handling / waiting_operator / resolved
  created_at          timestamptz DEFAULT now()
);

-- メッセージ（会話内の発言）
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  sender_type     text NOT NULL CHECK (sender_type IN ('user', 'assistant', 'operator')),
  content         text NOT NULL,
  created_at      timestamptz DEFAULT now()
);
```

`sender_type` を `'user'` / `'assistant'` / `'operator'` の 3 値にすることで、誰が送ったメッセージかを一つのカラムで表現している。Claude API に渡す `role` (`user` / `assistant`) とは別に管理しているのがポイントで、後述するが**この命名の混乱がデバッグの地獄につながった**。

### 通信フロー

```
顧客がメッセージ送信
  ↓
useChat.ts → POST /api/chat
  ↓
route.ts（サーバー側）
  ├─ Supabase にユーザーメッセージを INSERT
  ├─ 会話履歴を SELECT
  ├─ Claude API に会話履歴ごと渡して返答生成
  └─ Supabase にアシスタントメッセージを INSERT
        ↓
Supabase Realtime が変更を検知
  ↓
useChat.ts の subscription が受信 → 画面に表示
```

---

## 4. 実装で工夫したこと

### 4-1. Supabase Realtime 設計

チャットの最大の課題は「**返答が届いたら自動で画面が更新される**」体験の実現だ。ポーリング（定期的に API を叩く）ではなく、Supabase の `postgres_changes` を使ったプッシュ型にした。

```typescript
// hooks/useChat.ts（抜粋）
useEffect(() => {
  if (!conversationId) return;

  const channel = supabase
    .channel(`chat:${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${conversationId}`, // この会話だけ購読
      },
      (payload) => {
        const newMsg = payload.new as Message;
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) return prev; // 重複防止
          return [...prev, newMsg];
        });
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}, [conversationId, supabase]);
```

設計で気を付けたのは **2 点**。

1. **`filter` で会話 ID を絞る** — 全メッセージを購読すると、他の顧客のメッセージも届いてしまう。`conversation_id=eq.${conversationId}` で自分の会話だけに絞ることが重要。
2. **重複防止** — Realtime のイベントが稀に重複することがある。`prev.some((m) => m.id === newMsg.id)` で同じ ID のメッセージが既に存在する場合は追加しない。

オペレーター管理画面では **`conversations` テーブルも Realtime 購読**して、新着会話がリアルタイムで左サイドバーに追加されるようにした。

```sql
-- Realtime パブリケーションに追加（マイグレーション）
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
```

### 4-2. RLS による権限分離

Supabase の Row Level Security（RLS）は「誰がどのデータにアクセスできるか」をデータベースレベルで制御する仕組みだ。アプリ側のロジックでバリデーションするより安全で、設定漏れによるデータ漏洩リスクが下がる。

```sql
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 今回は匿名ユーザーも読み書きできるシンプルな設定
CREATE POLICY "Allow public to create conversations"
  ON conversations FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public to read conversations"
  ON conversations FOR SELECT USING (true);
```

現状は「全公開」ポリシーだが、将来的には以下のような拡張が可能だ。

```sql
-- 例: 自分のセッションの会話だけ読める
CREATE POLICY "Own session only"
  ON conversations FOR SELECT
  USING (customer_session_id = current_setting('app.session_id', true));
```

また、サーバー側（API Route）では **Service Role Key** を使うことで RLS を無視してすべてのデータにアクセスできる。Claude API を呼ぶ `/api/chat` では会話履歴を取得してから Claude に渡す必要があるため、ここだけ Service Role を使っている。

```typescript
// app/api/chat/route.ts（抜粋）
function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service Role Key
  return createClient(url, key, {
    auth: { persistSession: false }, // サーバーサイドではセッション不要
  });
}
```

**フロントエンドには絶対に Service Role Key を置いてはいけない**。`NEXT_PUBLIC_` のプレフィックスがあると自動的にブラウザに露出するため、`SUPABASE_SERVICE_ROLE_KEY` は `NEXT_PUBLIC_` なしにしている。

### 4-3. Claude API の会話履歴付き応答

Claude API の真価は「**会話の文脈を踏まえた返答**」にある。単発のプロンプトではなく、過去のメッセージを全て渡すことで自然な多ターン会話が実現する。

```typescript
// app/api/chat/route.ts（抜粋）

// 1. 会話履歴を取得
const { data: history } = await supabase
  .from("messages")
  .select("sender_type, content")
  .eq("conversation_id", conversationId)
  .order("created_at", { ascending: true });

// 2. Claude API の形式にマッピング
//    DB の sender_type → Claude の role に変換
const aiResponse = await anthropic.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  system: "You are a helpful customer support assistant. Be concise, friendly, and accurate.",
  messages: history.map((m) => ({
    role: m.sender_type as "user" | "assistant", // operator の発言は除外している
    content: m.content,
  })),
});
```

`system` プロンプトにサービス固有の情報（よくある質問、商品情報、対応範囲）を追加することで、FAQ ベースの応答が実現できる。

```typescript
system: `
あなたは○○サービスのカスタマーサポートです。
以下のルールに従って回答してください：
- 返金ポリシー: 購入から30日以内は返金可能
- 対応時間: 平日9時〜18時
- 答えられない質問は「オペレーターに確認します」と伝える
`,
```

### 4-4. エスカレーション判定の設計思想

「AI が答えられないとき、どうするか」は CS システムの核心だ。今回は `conversations.status` カラムでエスカレーション状態を管理する設計にした。

| ステータス | 意味 |
|---|---|
| `ai_handling` | Claude が自動対応中（デフォルト） |
| `waiting_operator` | オペレーターの介入が必要 |
| `resolved` | 対応完了 |

現在は手動でステータスを変更する運用だが、将来的には Claude の返答に特定のキーワードが含まれた場合に自動でエスカレーションする仕組みが実装できる。

```typescript
// 将来的な実装イメージ
const shouldEscalate = (response: string): boolean => {
  const triggers = [
    "オペレーターにお繋ぎします",
    "担当者に確認が必要",
    "複雑なご要件",
  ];
  return triggers.some((t) => response.includes(t));
};

if (shouldEscalate(assistantContent)) {
  await supabase
    .from("conversations")
    .update({ status: "waiting_operator" })
    .eq("id", conversationId);
}
```

---

## 5. 詰まった点と解決方法

ここからが本番だ。実装中に直面した 3 つのデバッグ地獄を正直に書く。

### 5-1. session_id カラム名の不一致

**症状**: Supabase から突然 400 エラー。エラーメッセージは:

```
Could not find the 'session_id' column of 'conversations' in the schema cache
```

**原因**: 実際の Supabase プロジェクトのテーブル定義では `customer_session_id` というカラム名だったのに、コード内では `session_id` と書いていた。

```typescript
// ❌ 間違い
await supabase.from("conversations").insert({ session_id: sessionId });

// ✅ 正しい
await supabase.from("conversations").insert({ customer_session_id: sessionId });
```

**教訓**: Supabase のテーブルを手動で作った場合、マイグレーションファイルと実際のスキーマが食い違うことがある。**Supabase のダッシュボード → Table Editor で実際のカラム名を必ず確認してからコードを書く**こと。

型定義（`src/types/index.ts`）と実際のカラム名を一致させるとエラーがすぐ見つかる。

```typescript
// src/types/index.ts
export type Conversation = {
  id: string;
  customer_session_id: string; // ← ここと DB のカラム名を合わせる
  status: string | null;
  created_at: string;
};
```

### 5-2. sender_type と role の混在

これが一番ハマった。**DB のカラム名**と **Claude API のフィールド名**が似て非なるものだったのだ。

| 場所 | フィールド名 | 値 |
|---|---|---|
| DB（messages テーブル） | `sender_type` | `'user'` / `'assistant'` / `'operator'` |
| Claude API（Messages API） | `role` | `'user'` / `'assistant'` |

実装当初、DB のカラムも `role` にしようとしたが、実際の Supabase プロジェクトのカラム名は `sender_type` だった。そのため、コードのあちこちで `role` と `sender_type` が混在し、次のエラーが出た。

```
Could not find the 'role' column of 'messages' in the schema cache
```

修正箇所は **7 か所**に散らばっていた。

```typescript
// ❌ 間違い（DB へのアクセスで role を使っている）
await supabase.from("messages").insert({ role: "user", content });
const { data } = await supabase.from("messages").select("role, content");

// ✅ 正しい（DB は sender_type、Claude API だけ role を使う）
await supabase.from("messages").insert({ sender_type: "user", content });
const { data } = await supabase.from("messages").select("sender_type, content");

// Claude API への変換
messages: history.map((m) => ({
  role: m.sender_type as "user" | "assistant", // DB→API の変換はここだけ
  content: m.content,
}))
```

**教訓**: DB のカラム名と外部 API のフィールド名は意図的に分けて管理する。混在すると修正範囲が広がる。TypeScript の型定義を先に固めておけば、コンパイルエラーとして気づけたはずだ。

### 5-3. 環境変数の再起動忘れ（と postgrest-js の Breaking Change）

**症状**: `NEXT_PUBLIC_SUPABASE_ANON_KEY` は正しく設定しているのに、Supabase から:

```
No API key found in request
```

というエラーが出続ける。

**原因その 1**: `.env.local` を編集した後に開発サーバーを再起動していなかった。Next.js は起動時に環境変数を読み込むため、**変更後は必ず `npm run dev` を再起動する**必要がある。

```bash
# .env.local を変更したら必ず再起動
Ctrl+C → npm run dev
```

**原因その 2**: それでも解決しなかった。調査した結果、`@supabase/postgrest-js 2.110.0` の **Breaking Change** が原因だった。この版から `apikey` ヘッダーを `global.headers` に明示的に渡さないと認識されないようになっていた。

```typescript
// src/lib/supabase/client.ts

// ❌ この書き方では 2.110.0 で apikey が送られない
export function createClient() {
  return createBrowserClient(url, key);
}

// ✅ global.headers に明示的に apikey を追加する
export function createClient() {
  return createBrowserClient(url, key, {
    global: {
      headers: { apikey: key },
    },
  });
}
```

**教訓**: ライブラリのバージョンアップ後にエラーが出たら、まず **Changelog** を確認する。今回のように「動いていたはずのコードが突然壊れる」のは Breaking Change のサインだ。`package.json` に書いたバージョンと実際にインストールされているバージョンのギャップにも注意が必要。

---

## 6. 学んだこと

### Next.js App Router の Server / Client 分割

「`"use client"` はどこに書くか」は最初はわかりにくい。今回の経験で得た判断基準はシンプルだ。

```
useState / useEffect / ブラウザ API を使う → "use client" が必要
それ以外（データ取得・表示のみ） → Server Component（デフォルト）
```

チャットウィジェットやオペレーター管理画面はリアルタイム状態を持つため `"use client"`。API Route（`route.ts`）はサーバーサイドのみで動くため、`"use client"` は不要かつ付けてはいけない。

### Supabase の認証モデル

| キー | 使う場所 | できること |
|---|---|---|
| `anon key` | ブラウザ（`NEXT_PUBLIC_`） | RLS ポリシーの範囲内で読み書き |
| `service role key` | サーバーのみ（`NEXT_PUBLIC_` なし） | RLS を無視して全データにアクセス |

この区別を理解してから実装の設計が格段に明快になった。**`service role key` が漏れると全データにフルアクセスできる**ので、絶対にフロントエンドには置かない。

### Claude API のメッセージ構造

Claude は会話の文脈を「messages 配列」として受け取る。配列の順序が重要で、最後のメッセージが `user` であることが必要だ。

```typescript
// messages は時系列順、最後は必ず user
messages: [
  { role: "user",      content: "返品したい" },
  { role: "assistant", content: "30日以内なら可能です" },
  { role: "user",      content: "3週間前に買いました" }, // ← 最後は user
]
```

`operator` が送ったメッセージは Claude API に渡さない（`sender_type === 'operator'` をフィルタリング）のがポイント。オペレーターの発言をそのまま渡すと、Claude が「operator」という謎の送信者がいると混乱する。

---

## 7. 今後の改善点

### 近期（優先度：高）

- **オペレーター認証** — 現在は `/operator` に誰でもアクセスできる。Supabase Auth でメールログインを実装する予定。
- **ステータスの手動変更** — 管理画面から「解決済み」に変更するボタンが未実装。

### 中期（優先度：中）

- **自動エスカレーション** — Claude の返答に「わかりません」「担当者に確認」などが含まれたら自動で `waiting_operator` に変更する。
- **オペレーター通知** — `waiting_operator` になったら Slack や Email で通知する。

### 長期（優先度：低）

- **FAQ 自動学習** — 解決済みの会話から FAQ を自動生成して system プロンプトに追加する。
- **分析ダッシュボード** — 対応件数・平均解決時間・AI 解決率などのメトリクスを可視化する。

---

## 8. おわりに

「チャットボットを作る」というと、OpenAI に投げて表示するだけのデモを想像しがちだ。しかし実際の CS 業務に使えるシステムには、**リアルタイム通信・権限管理・オペレーター引き継ぎ**といった要素が不可欠だと今回身をもって学んだ。

詰まった箇所のほとんどは「動くコード」を書くことより、**実際の API の仕様・カラム名・ライブラリのバージョン**を正確に把握することの重要性を教えてくれた。エラーメッセージを丁寧に読み、ライブラリのソースや Changelog を追う習慣が、AI エンジニアとしての地力になると実感している。

このシステムをベースに、FAQ ベース応答の精度向上・エスカレーション自動化・分析ダッシュボードと段階的に拡張していきたい。

---

**GitHub**: https://github.com/nobunori47/cs-chatbot  
**デモ**: https://cs-chatbot-flame.vercel.app
