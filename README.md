# cs-chatbot — フルスタック CS チャットボット

---

## プロジェクト概要

顧客サポート（CS）向けの AI チャットボットシステムです。  
Web サイトに埋め込んだチャットウィジェットから顧客がメッセージを送ると、Claude AI が自動で回答します。オペレーターはブラウザ上の管理画面からリアルタイムで会話を確認し、AI の返答に割り込んで直接返信することもできます。

```
顧客
 └─ チャットウィジェット（右下の吹き出しアイコン）
       └─ Supabase（メッセージ保存 + リアルタイム配信）
             ├─ Claude AI（自動返答）
             └─ オペレーター管理画面（/operator）
```

---

## 使用技術

| カテゴリ | 技術 | バージョン |
|---|---|---|
| フレームワーク | Next.js (App Router) | 16.x |
| 言語 | TypeScript | 5.x |
| スタイリング | Tailwind CSS | v4 |
| データベース / リアルタイム | Supabase | — |
| AI エンジン | Anthropic Claude (`claude-opus-4-8`) | — |
| デプロイ | Vercel | — |

---

## 主な機能

### 顧客向け（チャットウィジェット）

- **匿名セッション** — ログイン不要。ページを開くと自動的に匿名 ID が発行されます
- **AI 自動返答** — Claude が顧客のメッセージに日本語で回答します
- **リアルタイム受信** — 返答が届いたら画面が自動更新されます（ページ再読み込み不要）
- **会話履歴の保持** — ブラウザを閉じても同じデバイスなら会話が引き継がれます

### オペレーター向け（管理画面）

- **会話一覧** — 全顧客の会話をリアルタイムで一覧表示
- **ステータス管理** — 各会話の対応状況（AI 対応中 / 要対応 / 解決済）を色で識別
- **メッセージ詳細** — 顧客・AI・オペレーターの発言を時系列で確認
- **オペレーター返信** — 管理画面から直接顧客へ返信できます

---

## システム構成

```
src/
├── app/
│   ├── page.tsx                  # トップページ（チャットウィジェット設置場所）
│   ├── operator/
│   │   └── page.tsx              # オペレーター管理画面 (/operator)
│   └── api/
│       └── chat/
│           └── route.ts          # AI へのリクエスト処理（サーバー側）
├── components/
│   └── chat/
│       ├── ChatWidget.tsx        # チャットウィジェット本体（フローティングボタン）
│       ├── ChatInput.tsx         # メッセージ入力欄
│       ├── MessageList.tsx       # メッセージ一覧
│       └── MessageBubble.tsx     # 個別メッセージの吹き出し
├── hooks/
│   └── useChat.ts                # チャットのビジネスロジック
├── lib/
│   ├── supabase/
│   │   ├── client.ts             # ブラウザ用 Supabase クライアント
│   │   ├── server.ts             # サーバー用 Supabase クライアント
│   │   └── middleware.ts         # セッション更新処理
│   └── anthropic/
│       └── client.ts             # Claude API クライアント
└── types/
    └── index.ts                  # 型定義（Message, Conversation）

supabase/
└── migrations/
    └── 001_chat_schema.sql       # データベーススキーマ定義
```

### データベーステーブル

**conversations（会話）**

| カラム名 | 型 | 説明 |
|---|---|---|
| `id` | UUID | 会話 ID（自動生成） |
| `customer_session_id` | TEXT | 顧客の匿名セッション ID |
| `status` | TEXT | 対応状況（`ai_handling` / `waiting_operator` / `resolved`） |
| `created_at` | TIMESTAMP | 作成日時 |

**messages（メッセージ）**

| カラム名 | 型 | 説明 |
|---|---|---|
| `id` | UUID | メッセージ ID（自動生成） |
| `conversation_id` | UUID | 紐づく会話 ID |
| `sender_type` | TEXT | 送信者種別（`user` / `assistant` / `operator`） |
| `content` | TEXT | メッセージ本文 |
| `created_at` | TIMESTAMP | 送信日時 |

---

## セットアップ手順

### 前提条件

- Node.js 18 以上がインストールされていること
- Supabase プロジェクトが作成されていること
- Anthropic の API キーを取得していること

### 1. リポジトリのクローン

```bash
git clone https://github.com/nobunori47/cs-chatbot.git
cd cs-chatbot
```

### 2. パッケージのインストール

```bash
npm install
```

### 3. 環境変数の設定

プロジェクトルートに `.env.local` ファイルを作成し、次セクションの変数を記入します。

### 4. Supabase のデータベースセットアップ

Supabase ダッシュボード → **SQL Editor** を開き、`supabase/migrations/001_chat_schema.sql` の内容を貼り付けて実行します。

既存テーブルがある場合は以下の追加 SQL も実行してください：

```sql
-- status カラムの追加
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status text DEFAULT 'ai_handling';

-- operator 送信者の許可
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_type_check
  CHECK (sender_type IN ('user', 'assistant', 'operator'));

-- conversations のリアルタイム有効化
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
```

### 5. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開くと動作確認できます。  
管理画面は `http://localhost:3000/operator` です。

---

## 環境変数一覧

`.env.local` ファイルに以下の変数を設定してください。  
値は **Supabase ダッシュボード → Settings → API** および Anthropic コンソールから取得できます。

| 変数名 | 必須 | 説明 | 取得場所 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase プロジェクトの URL | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | 公開用 API キー（閲覧・投稿に使用） | Supabase → Settings → API → anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | 管理者用 API キー（サーバー側専用） | Supabase → Settings → API → service_role |
| `ANTHROPIC_API_KEY` | ✅ | Claude API キー | console.anthropic.com |
| `NEXT_PUBLIC_APP_URL` | — | アプリの公開 URL（本番環境用） | 例: `https://cs-chatbot-flame.vercel.app` |

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` は強力な管理者権限を持つキーです。`.env.local` を Git にコミットしないでください（`.gitignore` で除外済み）。

---

## 運用マニュアル（オペレーター向け）

### 管理画面へのアクセス

ブラウザで以下の URL を開きます：

- **本番環境**: https://cs-chatbot-flame.vercel.app/operator
- **開発環境**: http://localhost:3000/operator

### 画面の見方

```
┌──────────────────┬────────────────────────────────────────────┐
│  オペレーター管理   │             会話詳細                       │
│                  │                                            │
│ ● AI対応中        │  #a1b2c3d4  [AI対応中]    開始: 14:32      │
│ ● 要対応          │  ─────────────────────────────────────     │
│ ● 解決済          │                                            │
│                  │  顧客 14:32                                │
│ ─────────────    │  「返品はできますか？」                       │
│ [要対応] 14:32    │                                            │
│ #a1b2c3d4         │  AI 14:32                                  │
│ session: abc…     │  「ご購入から30日以内であれば...」              │
│                  │                                            │
│ [AI対応中] 14:28  │  オペレーター 14:35                         │
│ #e5f6g7h8         │  「ご不便をおかけして申し訳...」               │
│                  │                                            │
│                  │  ┌──────────────────────────────────────┐  │
│                  │  │ オペレーターとして返信                  │  │
│                  │  │ 返信内容を入力…                        │  │
│                  │  └──────────────────────────────────────┘  │
│                  │                                [送信]       │
└──────────────────┴────────────────────────────────────────────┘
```

### ステータスの意味

| 色 | ステータス | 意味 |
|---|---|---|
| 🔵 青 | AI 対応中 (`ai_handling`) | Claude が自動で返答している状態 |
| 🟡 黄 | 要対応 (`waiting_operator`) | オペレーターの介入が必要な状態 |
| 🟢 緑 | 解決済 (`resolved`) | 対応が完了した状態 |

### オペレーターが返信する手順

1. 左の会話一覧から対象の会話をクリック
2. 右側に会話の詳細（顧客・AI のやり取り）が表示される
3. 画面下部の入力欄に返信内容を入力
4. **Enter キー** または **「送信」ボタン** をクリック
5. 送信した返信は「オペレーター」としてインジゴ色の吹き出しで表示される

> 💡 改行したい場合は **Shift + Enter** を押してください。Enter 単体で送信されます。

### メッセージの色分け

| 色 | 送信者 | 説明 |
|---|---|---|
| 白（左） | 顧客 | 顧客が送ったメッセージ |
| グレー（左） | AI | Claude が自動生成した返答 |
| インジゴ（右） | オペレーター | オペレーターが送った返信 |

---

## FAQ メンテナンスガイド

### AI の回答内容を変更したい

`src/app/api/chat/route.ts` の `system` プロパティを編集します。

```typescript
system: "ここに AI への指示を記述します。",
```

**変更例：**
- 特定の商品情報や会社情報を追加する
- 回答のトーン（丁寧さ・カジュアルさ）を調整する
- 答えられない質問の範囲を明示する

変更後は `git push` すると Vercel が自動でデプロイします。

### 新しい会話のステータス初期値を変えたい

Supabase ダッシュボード → **SQL Editor** で以下を実行します：

```sql
-- 初期ステータスを「要対応」に変更する場合
ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'waiting_operator';
```

### Supabase のデータを直接確認・編集したい

Supabase ダッシュボード → **Table Editor** から、`conversations` / `messages` テーブルのデータを GUI で閲覧・編集できます。

### 古い会話データを削除したい

Supabase ダッシュボード → **SQL Editor** から以下を実行します（実行前に必ずバックアップを取ること）：

```sql
-- 90日以上前の会話と紐づくメッセージを削除
DELETE FROM conversations
WHERE created_at < now() - INTERVAL '90 days';
-- messages は ON DELETE CASCADE により自動削除されます
```

### チャットウィジェットを別のページにも設置したい

設置したいページのファイルに以下を追加します：

```tsx
import { ChatWidget } from "@/components/chat/ChatWidget";

// return 内の末尾に追加
<ChatWidget />
```

---

## デプロイ先

| 環境 | URL |
|---|---|
| 本番（Vercel） | https://cs-chatbot-flame.vercel.app |
| 管理画面 | https://cs-chatbot-flame.vercel.app/operator |
| GitHub | https://github.com/nobunori47/cs-chatbot |

### Vercel へのデプロイ手順

1. [Vercel](https://vercel.com) にログインし、GitHub リポジトリ `nobunori47/cs-chatbot` を連携
2. **Environment Variables** に `.env.local` と同じ変数を登録
3. `main` ブランチへの `git push` で自動デプロイが実行されます

---

## 今後の改善点

### 近期（優先度：高）

- **オペレーター認証** — 現在の管理画面はパスワードなしでアクセスできます。Supabase Auth でログイン機能を追加することを推奨します
- **会話ステータスの手動変更** — 管理画面から「解決済」などにステータスを変更できる UI の追加
- **未読バッジ** — 新着メッセージがある会話を視覚的に強調する表示

### 中期（優先度：中）

- **AI → オペレーター引き継ぎ機能** — AI が回答できないと判断した場合に自動で `waiting_operator` に切り替える仕組み
- **対応履歴の検索** — キーワードや日付で過去の会話を検索する機能
- **通知機能** — 新着会話発生時にブラウザ通知や Slack 通知を送る

### 長期（優先度：低）

- **ファイル添付** — 画像や PDF をメッセージに添付できる機能
- **多言語対応** — 英語・中国語など複数言語での自動応答
- **分析ダッシュボード** — 問い合わせ件数・解決率・応答時間などの指標表示
- **FAQ 自動学習** — 蓄積された会話データをもとに AI の回答精度を向上させる仕組み
