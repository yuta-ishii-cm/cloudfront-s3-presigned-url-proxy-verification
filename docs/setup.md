# CloudFront + S3 Presigned URL リバースプロキシ検証環境 構築指示書

## 背景

### 課題

企業のファイアウォールでS3ドメイン（`s3.amazonaws.com`）がブロックされるケースがある。
S3 Presigned URLによるファイルアップロード/ダウンロードがカスタムドメイン経由で動作するよう、CloudFrontをリバースプロキシとして機能させたい。

### 検証したいこと

1. CloudFront経由でS3 Presigned URL（GET/PUT）の署名検証が通るか
2. OAC（Origin Access Control）とPresigned URLが併用可能か
3. バケットポリシーによるCloudFront経由強制とPresigned URLが両立するか
4. CORS（ETagヘッダー含む）がCloudFront経由で正しく動作するか
5. マルチパートアップロードがCloudFront経由で動作するか

### 想定する本番構成

```
クライアント → https://custom-domain.com/upload/{key}?X-Amz-Signature=xxx
                  ↓ CloudFront（リバースプロキシ）
               https://{bucket}.s3.ap-northeast-1.amazonaws.com/upload/{key}?X-Amz-Signature=xxx
```

- アップロード: `/upload/*` パスでファイルをS3にPUT
- ダウンロード: `/data/*` パスでS3からGET
- 既存のダウンロード（メディア再生・プレビュー）はOAC経由で署名なしアクセス

### 先行検証で判明した事実

別環境のマネコンで以下を確認済み:

| テスト | 結果 |
|--------|------|
| OACあり + Presigned URL | **失敗**（`Only one auth mechanism allowed` — OACのAuthorizationヘッダーとPresigned URLのクエリ文字列署名が競合） |
| OACなし（Public） + Presigned URL | **成功**（GETで署名検証が通り、S3に正常到達） |

**結論: OACとPresigned URLは併用不可。Presigned URLを使うビヘイビアはOACなしにする必要がある。**

## 検証環境の構成

カスタムドメインは不要。CloudFrontのデフォルトドメイン（`xxx.cloudfront.net`）で検証する。

```
                       CloudFront (xxx.cloudfront.net)
                              │
              ┌───────────────┼──────────────────────┐
              │               │                      │
         /upload/*       /data-presigned/*          /data/*
         (OACなし)        (OACなし)                (OACあり)
              │               │                      │
              │          CF Function:                 │
              │          /data-presigned/ → /data/    │
              │               │                      │
              ▼               ▼                      ▼
        Upload Bucket   Download Bucket        Download Bucket
        (Presigned PUT)  (Presigned GET)        (OAC GET)
```

### ポイント

- `/data-presigned/*` と `/data/*` は**同じS3バケットの同じファイル**を参照する
- CloudFront Functionでパスを `/data-presigned/` → `/data/` に書き換えてS3に転送
- Presigned URLの署名はS3キー（`/data/...`）に対して生成されているので、書き換え後に署名検証が通る想定
- 検証環境ではバケットを分けているが、本番では同一バケットに2つのオリジン（OACあり/なし）を作る

| ビヘイビア | 用途 | OAC | CF Function | 検証内容 |
|-----------|------|-----|-------------|---------|
| `/upload/*` | Presigned URLでPUTアップロード | なし | なし | アップロードのリバプロ |
| `/data-presigned/*` | Presigned URLでGETダウンロード | なし | パス書き換え | ダウンロードのリバプロ + CF Functionの動作 |
| `/data/*` | 署名なしでGET（メディア再生・プレビュー模倣） | あり | なし | 既存機能の模倣 |

### 本番適用時の最終構成（検証成功した場合）

```
CloudFront (custom-domain.com)
├── /upload/*          → 3dtilesバケット (OACなし, Presigned URL PUT)
├── /data-presigned/*  → projectassetsバケット (OACなし, CF Function でパス書き換え, Presigned URL GET)
├── /data/*            → projectassetsバケット (OACあり, 署名なし GET) ← 既存のまま
└── /admin/api/*       → ALB (既存のまま)
```

サーバー側の変更:
- Presigned URL生成後、ドメインをカスタムドメインに差し替え
- ダウンロード用はパスの `/data/` を `/data-presigned/` に差し替え

### フォールバック（検証NGの場合）

CloudFront Function でのパス書き換え後にPresigned URLの署名検証が通らない場合、CloudFront署名（Signed URL/Cookie）方式を検討する。ただしマルチパートアップロードの各パートにCloudFront署名を適用する方法が課題になる。

## リポジトリセットアップ

### 前提

- Node.js v24 / pnpm
- AWS CDK v2
- AWSアカウントへのアクセス権限

### 初期化

```bash
pnpm init
pnpm add aws-cdk-lib constructs
pnpm add -D aws-cdk typescript @types/node
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner tsx
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "cdk.out"
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts"]
}
```

### `cdk.json`

```json
{
  "app": "npx ts-node bin/app.ts"
}
```

### `.gitignore`

```
node_modules/
cdk.out/
*.js
*.d.ts
```

## CDKスタック

### `bin/app.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import { ReverseProxyVerificationStack } from '../lib/reverse-proxy-verification-stack';

const app = new cdk.App();

new ReverseProxyVerificationStack(app, 'cf-reverse-proxy-verification', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
});
```

### `lib/reverse-proxy-verification-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * CloudFront リバースプロキシ検証用スタック
 *
 * S3 Presigned URL + CloudFrontプロキシの動作検証を行うための一時的なスタック。
 * 検証完了後に `cdk destroy` で削除する。
 */
export class ReverseProxyVerificationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3バケット ---

    // アップロード用バケット
    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    // ダウンロード用バケット
    const downloadBucket = new s3.Bucket(this, 'DownloadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.GET],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
        },
      ],
    });

    // --- CloudFront Function ---

    // /data-presigned/* → /data/* にパスを書き換えるFunction
    const rewriteFunction = new cloudfront.Function(
      this,
      'RewriteDataPresignedPath',
      {
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace('/data-presigned/', '/data/');
  return request;
}
        `),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment: 'Rewrite /data-presigned/* to /data/* for S3 key mapping',
      }
    );

    // --- CloudFrontディストリビューション ---

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Reverse Proxy Verification - DELETE AFTER TESTING',

      // デフォルトビヘイビア（ルートアクセス用ダミー）
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(downloadBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },

      additionalBehaviors: {
        // 検証1: アップロード（OACなし + Presigned URL）
        '/upload/*': {
          origin: origins.S3BucketOrigin.withBucketDefaults(uploadBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
        },

        // 検証2: ダウンロード（OACなし + Presigned URL + CF Function でパス書き換え）
        '/data-presigned/*': {
          origin: origins.S3BucketOrigin.withBucketDefaults(downloadBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: rewriteFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },

        // 検証3: 既存のメディア再生・プレビューを模倣（OACあり + 署名なし）
        '/data/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(
            downloadBucket
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
    });

    // --- Outputs ---

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFrontドメイン名（検証用URLのベース）',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFrontディストリビューションID',
    });

    new cdk.CfnOutput(this, 'UploadBucketName', {
      value: uploadBucket.bucketName,
      description: 'アップロード用バケット名（Presigned URL生成に使用）',
    });

    new cdk.CfnOutput(this, 'DownloadBucketName', {
      value: downloadBucket.bucketName,
      description: 'ダウンロード用バケット名（Presigned URL生成に使用）',
    });
  }
}
```

## 検証用スクリプト

### `scripts/generate-put-presigned-url.ts`

PUT用のPresigned URLを生成する（`aws s3 presign`はGETのみ対応のため）。

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({ region: 'ap-northeast-1' });

const bucketName = process.argv[2];
const key = process.argv[3] ?? 'upload/test-put.txt';

const command = new PutObjectCommand({
  Bucket: bucketName,
  Key: key,
  ContentType: 'text/plain',
});

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
console.log(url);
```

### `scripts/generate-multipart-presigned-urls.ts`

マルチパートアップロード検証用のPresigned URLを生成する。

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({ region: 'ap-northeast-1' });
const bucketName = process.argv[2];
const key = 'upload/test-multipart.txt';

const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: 'text/plain',
  })
);

console.log(`UploadId: ${UploadId}`);
console.log(`Key: ${key}`);

for (const partNumber of [1, 2]) {
  const url = await getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucketName,
      Key: key,
      PartNumber: partNumber,
      UploadId,
    }),
    { expiresIn: 3600 }
  );
  console.log(`Part ${partNumber}: ${url}`);
}
```

## デプロイ

```bash
npx cdk bootstrap --profile {PROFILE}
npx cdk deploy --profile {PROFILE}
```

デプロイ後、以下のOutputsが出力される:
- `DistributionDomainName` — CloudFrontドメイン（例: `d1234567890.cloudfront.net`）
- `DistributionId` — ディストリビューションID
- `UploadBucketName` — アップロード用バケット名
- `DownloadBucketName` — ダウンロード用バケット名

## 検証手順

以下、Outputsの値を変数として使用:

```bash
CF_DOMAIN="<DistributionDomainName>"
UPLOAD_BUCKET="<UploadBucketName>"
DOWNLOAD_BUCKET="<DownloadBucketName>"
PROFILE="{PROFILE}"
```

### 検証1: Presigned URL GET（署名検証の確認）

```bash
# Presigned URL生成（GET）
PRESIGNED_URL=$(aws s3 presign s3://${UPLOAD_BUCKET}/upload/test.txt --expires-in 3600 --profile ${PROFILE})

# S3直接アクセス（ベースライン）
curl -s -o /dev/null -w "S3直接: %{http_code}\n" "${PRESIGNED_URL}"
# → 404（オブジェクトがないので正常）

# ドメイン差し替え（CloudFront経由）
CF_URL=$(echo "${PRESIGNED_URL}" | sed "s|https://${UPLOAD_BUCKET}.s3.ap-northeast-1.amazonaws.com|https://${CF_DOMAIN}|")

curl -s -o /dev/null -w "CloudFront経由: %{http_code}\n" "${CF_URL}"
# → 404なら成功（署名検証が通りS3に到達）
# → 403なら失敗
```

### 検証2: Presigned URL PUT（ファイルアップロード）

```bash
# Presigned URL生成（PUT）
PUT_URL=$(npx tsx scripts/generate-put-presigned-url.ts ${UPLOAD_BUCKET} upload/test-put.txt)

# S3直接でPUT（ベースライン）
curl -s -o /dev/null -w "S3直接PUT: %{http_code}\n" \
  -X PUT "${PUT_URL}" \
  -H "Content-Type: text/plain" \
  -d "hello reverse proxy"
# → 200なら成功

# ドメイン差し替え（CloudFront経由）
CF_PUT_URL=$(echo "${PUT_URL}" | sed "s|https://${UPLOAD_BUCKET}.s3.ap-northeast-1.amazonaws.com|https://${CF_DOMAIN}|")

curl -s -o /dev/null -w "CloudFront経由PUT: %{http_code}\n" \
  -X PUT "${CF_PUT_URL}" \
  -H "Content-Type: text/plain" \
  -d "hello reverse proxy via cloudfront"
# → 200なら成功
```

### 検証3: Presigned URL GET + CloudFront Function パス書き換え（ダウンロード）

この検証が最も重要。S3キーは `/data/...` だが、CloudFrontへのリクエストは `/data-presigned/...` で行い、
CF Functionがパスを書き換えてS3に転送する。署名はS3キー（`/data/...`）に対して生成されているので、
書き換え後に署名検証が通るかを確認する。

```bash
# テストファイルをS3キー /data/... にアップロード
aws s3 cp - s3://${DOWNLOAD_BUCKET}/data/test-download.txt \
  --profile ${PROFILE} <<< "download test content via cf function"

# Presigned URL生成（S3キー /data/... に対して署名）
DL_URL=$(aws s3 presign s3://${DOWNLOAD_BUCKET}/data/test-download.txt --expires-in 3600 --profile ${PROFILE})

# ドメイン差し替え + パスを /data/ → /data-presigned/ に変更
CF_DL_URL=$(echo "${DL_URL}" | sed "s|https://${DOWNLOAD_BUCKET}.s3.ap-northeast-1.amazonaws.com/data/|https://${CF_DOMAIN}/data-presigned/|")

curl -s -w "\nHTTP: %{http_code}\n" "${CF_DL_URL}"
# → "download test content via cf function" + HTTP: 200 なら成功
#    （CF Functionが /data-presigned/ → /data/ に書き換え、S3キーと一致し、署名検証も通った）
# → 403なら失敗（署名検証エラー → CF Functionのパス書き換えと署名の不整合の可能性）
```

### 検証4: OACあり（既存機能の模倣）

```bash
# テストファイルをアップロード
aws s3 cp - s3://${DOWNLOAD_BUCKET}/data/test-oac.txt \
  --profile ${PROFILE} <<< "oac access test"

# OAC経由アクセス（署名なし）
curl -s -w "\nHTTP: %{http_code}\n" \
  "https://${CF_DOMAIN}/data/test-oac.txt"
# → "oac access test" + HTTP: 200 なら成功（OACで認証）

# S3直接アクセス（署名なし） → 拒否されるはず
curl -s -o /dev/null -w "S3直接（署名なし）: %{http_code}\n" \
  "https://${DOWNLOAD_BUCKET}.s3.ap-northeast-1.amazonaws.com/data/test-oac.txt"
# → 403なら正常（BlockPublicAccessが効いている）
```

### 検証5: CORS

```bash
curl -s -X OPTIONS \
  "https://${CF_DOMAIN}/upload/test" \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v 2>&1 | grep -i "access-control"

# 確認ポイント:
# - Access-Control-Allow-Origin が返るか
# - Access-Control-Expose-Headers に ETag が含まれるか
```

### 検証6: マルチパートアップロード

```bash
# Presigned URL生成
npx tsx scripts/generate-multipart-presigned-urls.ts ${UPLOAD_BUCKET}

# 出力されたURLのドメインを差し替えて、各パートをPUT
# Part 1
curl -s -D - -o /dev/null \
  -X PUT "${CF_PART1_URL}" \
  -d "part1-data-xxxxxxxx"
# → ETagヘッダーをメモ

# Part 2
curl -s -D - -o /dev/null \
  -X PUT "${CF_PART2_URL}" \
  -d "part2-data-xxxxxxxx"
# → ETagヘッダーをメモ
```

## クリーンアップ

```bash
npx cdk destroy --profile {PROFILE}
```

全リソース（S3バケット、CloudFrontディストリビューション）が削除される。

## チェックリスト

| # | 項目 | 検証 | 期待結果 |
|---|------|------|---------|
| 1 | CloudFront経由 + Presigned URL (GET) | 検証1 | 404 or 200 |
| 2 | CloudFront経由 + Presigned URL (PUT) | 検証2 | 200 |
| 3 | **CF Function パス書き換え + Presigned URL (GET)** | **検証3** | **200 + ファイル内容** |
| 4 | OACあり + 署名なしアクセス | 検証4 | 200 |
| 5 | CORS: Access-Control-Allow-Origin | 検証5 | ヘッダーあり |
| 6 | CORS: Access-Control-Expose-Headers: ETag | 検証5 | ヘッダーあり |
| 7 | マルチパートPUT + ETag取得 | 検証6 | 200 + ETagヘッダー |
| 8 | S3直接アクセス（署名なし）が拒否される | 検証4 | 403 |

**#3が最重要**: CF Functionでパスを書き換えた後もPresigned URLの署名検証が通るかの確認。
これがNGの場合、フォールバック（CloudFront署名方式）の検討が必要。

## 本番適用時の注意事項

1. **OACとPresigned URLは併用不可**: Presigned URLを使うビヘイビアはOACなし（Public）にする
2. **ダウンロード側のパス分離が必要**: 既存のメディア再生・プレビュー（OACあり）とPresigned URLダウンロード（OACなし）が同じパスを共有する場合、CloudFront Functionでのパス書き換え等で分離する
3. **セキュリティ**: OACなしでも BlockPublicAccess + バケットポリシー（SourceArn条件） + Presigned URL署名の3層で保護可能
4. **Security Hub**: OACなしのS3オリジンが検知される可能性あり。バケットポリシーでCloudFront経由を強制していることをドキュメント化しておく
5. **WAF**: 本番のCloudFrontにはWAF（デフォルト拒否 + IP制限で許可）が設定されている。`/upload/*` や Presigned URLダウンロード用パスへのリクエストがWAFルールを通過できることを確認する必要がある。検証環境にはWAFを含めていないため、本番適用時に別途確認が必要

## 技術的な補足

### AllViewerExceptHostHeader が必要な理由

Presigned URLの署名には `Host` ヘッダーが含まれており、S3バケットのドメイン（`bucket.s3.amazonaws.com`）に対して署名されている。
CloudFront経由でリクエストが来た場合、`Host` ヘッダーはカスタムドメイン（`custom-domain.com`）になっている。
`AllViewerExceptHostHeader` を使うことで、`Host` ヘッダーを除外してS3に転送する。S3はオリジンの `Host`（自分のドメイン）を使うため、署名検証が通る。

### セキュリティ: OACなしでも安全な理由

OACなし（Public）のオリジンでも、以下の3層で保護される:

1. **BlockPublicAccess: BLOCK_ALL** — S3バケットへの未認証の直接アクセスを拒否
2. **バケットポリシー（SourceArn条件）** — CloudFrontディストリビューション経由のアクセスのみ許可。S3直接アクセスを拒否
3. **Presigned URL署名** — 有効な署名（IAMクレデンシャルで生成、1時間で失効）がないリクエストをS3が拒否

### 案2（CloudFront署名付きURL）を採用しない理由

CloudFront署名付きURL（RSA鍵ペアで署名）は、OACとの競合がなく構成がシンプルだが、以下の理由で不採用:

- **マルチパートアップロードとの相性が悪い**: `CreateMultipartUpload` や `CompleteMultipartUpload` はS3 APIであり、CloudFront署名では呼び出せない。各パートのPUTはCF署名で可能だが、マルチパート全体のフローをCF署名だけでは完結できない
- **既存コードの変更量が大きい**: 署名ロジックをS3 Presigned URLからCloudFront署名に全面変更する必要がある
- **鍵管理が追加で必要**: RSA鍵ペアの生成・ローテーション・Parameter Storeでの管理が必要

参考: https://dev.classmethod.jp/articles/cloudfront-signed-url-get-and-put/
