# Claude + Supabase でフルスタック CS チャットボットを作った話

**GitHub**: https://github.com/nobunori47/cs-chatbot  
**デモ**: https://cs-chatbot-flame.vercel.app

---

## 1. はじめに — 何を作ったか

「AI チャットボット」という言葉はもう珍しくないが、**実際の CS 業務に使えるもの**はまだ少ない。よくある実装は「とりあえず LLM に投げて表示する」だけで、オペレーターへの引き継ぎや会話管理まで含んだフルスタックな構成にはなっていないことが多い。

そこで今回作ったのが、次の構成を持つ顧客サポート（CS）チャットボットだ。

```
顧客
 └─ チャットウィジェット（Web サイトに埋め込み）
       └─ Supabase（メッセージ保存 + リアルタイム配信）
             ├─ Claude AI（自動返答）
             └─ オペレーター管理画面（/operator）
```

顧客はログイン不要で会話を開始でき、Claude が自動で返答する。オペレーターはブラウザの管理画面からすべての会話をリアルタイムで監視し、必要に応じて割り込んで直接返信できる。

**「AI が一次対応、人間が二次対応」という CS の現実に沿ったシステム**を、一から実装してみたのが今回の挑戦だった。

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

2 テーブル構成にした。`sender_type` で「誰が送ったか」を区別するのがポイントだ。

```sql
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_session_id text NOT NULL,
  status              text DEFAULT 'ai_handling', -- ai_handling / waiting_operator / resolved
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  sender_type     text NOT NULL CHECK (sender_type IN ('user', 'assistant', 'operator')),
  content         text NOT NULL,
  created_at      timestamptz DEFAULT now()
);
```

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
useChat.ts の subscription が受信 → 画面に自動表示
```

---

## 4. 実装で工夫したこと

### 4-1. Supabase Realtime 設計　✅ 実装済み

チャットの要は「**返答が届いたら画面が自動で更新される**」体験だ。ポーリングではなく `postgres_changes` を使ったプッシュ型にした。

```typescript
const channel = supabase
  .channel(`chat:${conversationId}`)
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`, // この会話だけ購読
  }, (payload) => {
    const newMsg = payload.new as Message;
    setMessages((prev) => {
      if (prev.some((m) => m.id === newMsg.id)) return prev; // 重複防止
      return [...prev, newMsg];
    });
  })
  .subscribe();
```

設計上の 2 つのポイント：

1. **`filter` で会話 ID を絞る** — 絞らないと他の顧客のメッセージも全件届く
2. **重複防止** — Realtime はまれにイベントが重複するため、同 ID のメッセージは追加しない

オペレーター管理画面では `conversations` テーブルも購読し、新着会話がサイドバーにリアルタイム追加されるようにした。

### 4-2. RLS による権限分離　✅ 実装済み

Supabase の Row Level Security（RLS）は「誰がどのデータにアクセスできるか」をデータベースレベルで制御する仕組みだ。アプリ側のロジックでバリデーションするより安全で、設定漏れによるデータ漏洩リスクが下がる。

現在は匿名ユーザーが読み書きできるシンプルなポリシーを採用している。

```sql
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read/write" ON conversations FOR ALL USING (true) WITH CHECK (true);
```

また、サーバー側（API Route）では RLS を無視できる **Service Role Key** を使っている。フロントエンドには `NEXT_PUBLIC_` で始まる anon key のみを渡し、**Service Role Key はサーバー専用**として環境変数名からも `NEXT_PUBLIC_` を外している。

> **🔮 将来構想** — 本番導入時は「自分のセッションの会話だけ読める」ポリシーに厳格化する予定。`current_setting('app.session_id')` を使った行レベル制御が定石だ。

### 4-3. Claude API の会話履歴付き応答 + FAQ 検索　✅ 実装済み（FAQ 検索は設計パターン）

Claude API の真価は「**会話の文脈を踏まえた返答**」にある。DB から取得した全メッセージ履歴を渡すことで、自然な多ターン会話が実現する。

```typescript
const aiResponse = await anthropic.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  system: "あなたは○○サービスのカスタマーサポートです。...",
  messages: history
    .filter((m) => m.sender_type !== "operator") // operator の発言は除外
    .map((m) => ({
      role: m.sender_type as "user" | "assistant", // DB の sender_type → API の role に変換
      content: m.content,
    })),
});
```

`system` プロンプトに返金ポリシーや対応時間などを直書きすることで、FAQ ベースの応答が実現できる。さらに精度を上げるには、**FAQ 検索を挟む設計パターン**が有効だ。

```
顧客メッセージ
  ↓
FAQ テーブルをキーワード検索（例: pgvector で類似検索）
  ↓
関連 FAQ を最大 3 件取得
  ↓
system プロンプトに「参考情報」として追記
  ↓
Claude へ送信 → FAQ を踏まえた回答を生成
```

今回は system プロンプトへの直書きで対応しているが、FAQ テーブルを別途管理してベクトル検索で関連情報を動的に挿入する構成にすると、知識のメンテナンスが格段に楽になる。

### 4-4. エスカレーション判定　🔮 将来構想

「AI が答えられないとき、どうするか」は CS システムの核心だ。今回は `conversations.status` カラムでエスカレーション状態を管理する**設計のみ実装**した。

| ステータス | 意味 |
|---|---|
| `ai_handling` | Claude が自動対応中（デフォルト） |
| `waiting_operator` | オペレーターの介入が必要 |
| `resolved` | 対応完了 |

現状はオペレーターが手動でステータスを把握して対応する運用だが、次のロジックで自動エスカレーションが実現できる。

```typescript
// 将来的な実装イメージ
const ESCALATION_TRIGGERS = ["わかりかねます", "担当者に確認", "対応できません"];

if (ESCALATION_TRIGGERS.some((t) => assistantContent.includes(t))) {
  await supabase
    .from("conversations")
    .update({ status: "waiting_operator" })
    .eq("id", conversationId);
}
```

---

## 5. 詰まった点と解決方法

ここからが本番だ。実装中に直面した 3 つのデバッグを正直に書く。

### 5-1. session_id カラム名の不一致

**エラー**: `Could not find the 'session_id' column of 'conversations'`

**原因**: 実際の Supabase プロジェクトのカラム名は `customer_session_id` だったのに、コードには `session_id` と書いていた。マイグレーションファイルと実際のスキーマが食い違っていた。

**教訓**: テーブルを手動で作った場合、**Supabase ダッシュボード → Table Editor で実際のカラム名を必ず確認してからコードを書く**。TypeScript の型定義（`src/types/index.ts`）を先に DB のカラム名と合わせておけば、コンパイルエラーとして即座に気づける。

### 5-2. sender_type と role の混在

**エラー**: `Could not find the 'role' column of 'messages'`

**原因**: DB のカラム名と Claude API のフィールド名が似て非なるものだった。

| 場所 | フィールド名 | 値 |
|---|---|---|
| DB（messages テーブル） | `sender_type` | `'user'` / `'assistant'` / `'operator'` |
| Claude API（Messages API） | `role` | `'user'` / `'assistant'` |

コードのあちこちで `role` と `sender_type` が混在し、修正箇所が **7 か所**に散らばっていた。

**教訓**: DB のカラム名と外部 API のフィールド名は意図的に分けて管理する。「DB へのアクセスは `sender_type`、Claude API への変換は `.map()` の中だけで `role` に変換する」と決めると混乱しない。

### 5-3. 環境変数の再起動忘れ + ライブラリの Breaking Change

**エラー**: `No API key found in request`（anon key は正しく設定済みなのに）

**原因その 1**: `.env.local` を編集した後、開発サーバーを再起動していなかった。Next.js は環境変数を**起動時に一度だけ**読み込む。

**原因その 2**: それでも解決しなかった。`@supabase/postgrest-js 2.110.0` の **Breaking Change** が原因で、`apikey` ヘッダーを `global.headers` に明示的に渡さないと認識されなくなっていた。

```typescript
// ✅ 2.110.0 以降の正しい書き方
return createBrowserClient(url, key, {
  global: { headers: { apikey: key } },
});
```

**教訓**: 「動いていたコードが突然壊れる」は Breaking Change のサイン。まず **Changelog と `package.json` のバージョン**を確認する習慣が大切だ。

---

## 6. 学んだこと

### Next.js App Router の Server / Client 分割

判断基準はシンプルだ。

```
useState / useEffect / ブラウザ API を使う → "use client" が必要
データ取得・表示のみ             → Server Component（デフォルト）
```

チャットウィジェットやオペレーター管理画面は Realtime 状態を持つため `"use client"`。API Route（`route.ts`）はサーバー専用なので `"use client"` は不要かつ付けてはいけない。

### Supabase の認証モデル

| キー | 使う場所 | できること |
|---|---|---|
| `anon key` | ブラウザ（`NEXT_PUBLIC_`） | RLS ポリシーの範囲内で読み書き |
| `service role key` | サーバーのみ | RLS を無視して全データにアクセス |

この区別を理解してから、設計の意思決定が格段に明快になった。**`service role key` が漏れると全データにフルアクセスできる**ので、フロントエンドには絶対に置かない。

### Claude API のメッセージ構造

Claude は会話の文脈を「messages 配列」で受け取る。最後の要素は必ず `role: "user"` でなければならない。また、`operator` の発言はフィルタリングして渡さない（`role` に `"operator"` は存在しないため）。

---

## 7. 今後の改善点

| 優先度 | 内容 | 備考 |
|---|---|---|
| 🔴 高 | オペレーター認証 | `/operator` は現在パスワードなし。Supabase Auth で実装予定 |
| 🔴 高 | ステータスの手動変更 UI | 「解決済み」に変更するボタンが未実装 |
| 🟡 中 | 自動エスカレーション | Claude の返答トリガーワードで `waiting_operator` に自動遷移 |
| 🟡 中 | オペレーター通知 | `waiting_operator` 時に Slack / Email 通知 |
| 🟢 低 | FAQ ベクトル検索 | pgvector で類似 FAQ を動的に取得して system プロンプトに注入 |
| 🟢 低 | 分析ダッシュボード | 対応件数・AI 解決率・平均応答時間などの可視化 |

---

## 8. 今回の成果

今回の開発で完成した機能を整理する。

**顧客向けチャットウィジェット**
- ログイン不要の匿名セッション発行（`crypto.randomUUID()` + `localStorage`）
- Claude による自動返答（会話履歴付き多ターン対話）
- Supabase Realtime によるメッセージの自動受信
- ブラウザを閉じても引き継がれる会話履歴

**オペレーター管理画面（`/operator`）**
- 全会話のリアルタイム一覧表示（新着会話が即座に追加）
- ステータスバッジによる優先度の視覚化（AI 対応中 / 要対応 / 解決済）
- 会話詳細の表示（顧客・AI・オペレーターの発言を色分け）
- オペレーターとしての返信送信（`sender_type: 'operator'`）

**インフラ・セキュリティ**
- RLS によるデータベースレベルの権限制御
- anon key / service role key の適切な使い分け
- Vercel + GitHub による自動デプロイパイプライン

---

## 9. おわりに

「チャットボットを作る」というと、LLM に投げて表示するだけのデモを想像しがちだ。しかし実際の CS 業務に使えるシステムには、**リアルタイム通信・権限管理・オペレーター引き継ぎ**といった要素が不可欠だと今回身をもって学んだ。

詰まった箇所のほとんどは「動くコードを書くこと」より、**実際の API 仕様・カラム名・ライブラリのバージョン**を正確に把握することの重要性を教えてくれた。

そして今回の開発で最も大切だと感じたのは、この一言に尽きる。

> **「動けば完成ではなく、安全に運用できることまでが品質だ。」**

RLS の設計・環境変数の管理・認証の実装——これらはプロダクトとして出荷するときに初めて必要になるものではなく、設計の段階から考慮すべきことだった。次のプロダクトでは最初からセキュリティと運用を設計に組み込みたい。

---

**GitHub**: https://github.com/nobunori47/cs-chatbot  
**デモ**: https://cs-chatbot-flame.vercel.app
